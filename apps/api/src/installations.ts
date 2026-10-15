/**
 * GitHub App installations: the accounts that have installed the App.
 *
 * Why we keep them at all: an installation is the only way the service can act as the
 * App — mint an installation token and read a repository without a human present. That
 * is what a periodic resync, a backfill, or a future "show me the offices I can see"
 * listing needs.
 *
 * What this is **not**: an ACL. CLAUDE.md rule 6 — GitHub is the only ACL, and
 * `GET /office/...` is authorized by asking GitHub with the *caller's* token
 * (see access.ts). An installation row never grants anybody a read.
 *
 * No credential is stored. Installation tokens are minted on demand and cached in
 * memory (app-auth.ts); user access tokens live in the session store (session.ts).
 */

import type { Queryable } from "./db.js";

export interface Installation {
  /** GitHub's installation id, the one `installation_id` in the setup callback carries. */
  installationId: number;
  /** The account the App is installed on: a user or an organization. */
  accountLogin: string;
  accountId?: number | undefined;
  /** "User" or "Organization", as GitHub reports it. */
  accountType?: string | undefined;
  /** "all" or "selected": whether every repository of the account was granted. */
  repositorySelection?: string | undefined;
  /** GitHub lets an owner suspend an App without uninstalling it. */
  suspended: boolean;
}

export interface InstallationStore {
  upsert(installation: Installation): Promise<void>;
  get(installationId: number): Promise<Installation | undefined>;
  /** By account login, case-insensitively — GitHub logins are. */
  byAccount(login: string): Promise<Installation | undefined>;
  remove(installationId: number): Promise<void>;
  list(): Promise<Installation[]>;
}

type Obj = Record<string, unknown>;

/**
 * Read GitHub's `installation` object — the one in an `installation` delivery and in
 * the `GET /app/installations/{id}` response — into our own shape. Returns undefined
 * for anything that is not recognisably an installation.
 */
export function installationFromPayload(value: unknown): Installation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Obj;

  const installationId = Number(obj["id"]);
  if (!Number.isInteger(installationId) || installationId <= 0) return undefined;

  const account = (typeof obj["account"] === "object" && obj["account"] !== null ? obj["account"] : {}) as Obj;
  const login = account["login"];
  if (typeof login !== "string" || login.length === 0) return undefined;

  const accountId = Number(account["id"]);
  const accountType = account["type"];
  const selection = obj["repository_selection"];

  return {
    installationId,
    accountLogin: login,
    ...(Number.isInteger(accountId) ? { accountId } : {}),
    ...(typeof accountType === "string" ? { accountType } : {}),
    ...(typeof selection === "string" ? { repositorySelection: selection } : {}),
    suspended: obj["suspended_at"] != null,
  };
}

/** Process-local installations. Lost on restart; fine without `DATABASE_URL`. */
export class InMemoryInstallationStore implements InstallationStore {
  readonly #byId = new Map<number, Installation>();

  async upsert(installation: Installation): Promise<void> {
    this.#byId.set(installation.installationId, installation);
  }

  async get(installationId: number): Promise<Installation | undefined> {
    return this.#byId.get(installationId);
  }

  async byAccount(login: string): Promise<Installation | undefined> {
    const wanted = login.toLowerCase();
    for (const installation of this.#byId.values()) {
      if (installation.accountLogin.toLowerCase() === wanted) return installation;
    }
    return undefined;
  }

  async remove(installationId: number): Promise<void> {
    this.#byId.delete(installationId);
  }

  async list(): Promise<Installation[]> {
    return [...this.#byId.values()].sort((a, b) => a.installationId - b.installationId);
  }
}

interface Row {
  installation_id: string;
  account_login: string;
  account_id: string | null;
  account_type: string | null;
  repository_selection: string | null;
  suspended: boolean;
}

/** `installations` from `migrations/002_installations.sql`, plain SQL (ADR 0001). */
export class PostgresInstallationStore implements InstallationStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async upsert(installation: Installation): Promise<void> {
    await this.#db.query(
      `insert into installations
              (installation_id, account_login, account_id, account_type, repository_selection, suspended)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (installation_id)
       do update set account_login        = excluded.account_login,
                     account_id           = excluded.account_id,
                     account_type         = excluded.account_type,
                     repository_selection = excluded.repository_selection,
                     suspended            = excluded.suspended,
                     updated_at           = now()`,
      [
        installation.installationId,
        installation.accountLogin,
        installation.accountId ?? null,
        installation.accountType ?? null,
        installation.repositorySelection ?? null,
        installation.suspended,
      ],
    );
  }

  async get(installationId: number): Promise<Installation | undefined> {
    const { rows } = await this.#db.query<Row>(`${SELECT} where installation_id = $1`, [installationId]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async byAccount(login: string): Promise<Installation | undefined> {
    const { rows } = await this.#db.query<Row>(
      `${SELECT} where lower(account_login) = lower($1) order by installation_id limit 1`,
      [login],
    );
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async remove(installationId: number): Promise<void> {
    await this.#db.query("delete from installations where installation_id = $1", [installationId]);
  }

  async list(): Promise<Installation[]> {
    const { rows } = await this.#db.query<Row>(`${SELECT} order by installation_id`);
    return rows.map(fromRow);
  }
}

/** `bigint` comes back from `pg` as a string, so cast it where it is read. */
const SELECT = `select installation_id::text as installation_id,
                       account_login,
                       account_id::text as account_id,
                       account_type,
                       repository_selection,
                       suspended
                  from installations`;

function fromRow(row: Row): Installation {
  return {
    installationId: Number(row.installation_id),
    accountLogin: row.account_login,
    ...(row.account_id != null ? { accountId: Number(row.account_id) } : {}),
    ...(row.account_type != null ? { accountType: row.account_type } : {}),
    ...(row.repository_selection != null ? { repositorySelection: row.repository_selection } : {}),
    suspended: row.suspended,
  };
}

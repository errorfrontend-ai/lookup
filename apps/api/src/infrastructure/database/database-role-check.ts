/** Anything that can run a query and return rows: a TypeORM DataSource or a plain pg client wrapper. */
export interface QueryRunnerLike {
  query(sql: string): Promise<unknown>;
}

interface DatabaseRoleFacts {
  role_name: string;
  is_superuser: boolean;
  bypasses_row_level_security: boolean;
  owns_application_tables: boolean;
}

/**
 * Row-level security only protects stations from each other if the API connects as a role it
 * applies to. Superusers, BYPASSRLS roles and table owners all skip it, so refuse to start as any
 * of them.
 */
export async function assertDatabaseRoleIsRestricted(database: QueryRunnerLike): Promise<void> {
  const rows = (await database.query(
    `SELECT current_user AS role_name,
            connected_role.rolsuper AS is_superuser,
            connected_role.rolbypassrls AS bypasses_row_level_security,
            EXISTS (SELECT 1 FROM pg_tables AS owned_table
                     WHERE owned_table.schemaname IN ('app', 'fingerprints')
                       AND owned_table.tableowner = current_user) AS owns_application_tables
       FROM pg_roles AS connected_role WHERE connected_role.rolname = current_user`,
  )) as DatabaseRoleFacts[];
  const facts = rows[0];
  if (!facts || facts.is_superuser || facts.bypasses_row_level_security || facts.owns_application_tables) {
    throw new Error(
      'Refusing to start: the API database role must not be a superuser, bypass row-level security, ' +
        `or own tables (role=${facts?.role_name ?? 'unknown'} superuser=${facts?.is_superuser} ` +
        `bypasses_row_level_security=${facts?.bypasses_row_level_security} owns_tables=${facts?.owns_application_tables}).`,
    );
  }
}

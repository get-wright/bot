declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean });
    run(sql: string, ...params: unknown[]): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): void;
    };
    query(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): void;
    };
    close(): void;
  }
}

declare namespace globalThis {
  // eslint-disable-next-line no-var
  var Bun: object | undefined;
}

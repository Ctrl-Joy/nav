// A top-level CLI command. `run` receives the arguments after the command name.
export interface CommandDef {
  name: string;
  summary: string;
  usage: string[];
  run: (argv: string[]) => Promise<void>;
}

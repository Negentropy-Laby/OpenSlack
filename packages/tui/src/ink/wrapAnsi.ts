import wrapAnsiNpm from 'wrap-ansi';

type WrapAnsiOptions = {
  hard?: boolean;
  wordWrap?: boolean;
  trim?: boolean;
};

const wrapAnsiBun = null as
  | ((input: string, columns: number, options?: WrapAnsiOptions) => string)
  | null;

const wrapAnsi: (input: string, columns: number, options?: WrapAnsiOptions) => string =
  wrapAnsiBun ?? wrapAnsiNpm;

export { wrapAnsi };

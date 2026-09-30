// Terminal questions for the setup scripts. askHidden doesn't echo what is typed (for passwords).
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
const writeOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => { if (!muted) writeOutput(s); };
const lines = rl[Symbol.asyncIterator](); // buffers input, so piped answers aren't lost

export async function ask(question) {
  process.stdout.write(question);
  const { value = '' } = await lines.next();
  return value;
}

export async function askHidden(question) {
  muted = true;
  const answer = await ask(question);
  muted = false;
  process.stdout.write('\n');
  return answer;
}

export function quit(message, code = 1) {
  console.log(message);
  rl.close();
  process.exit(code);
}

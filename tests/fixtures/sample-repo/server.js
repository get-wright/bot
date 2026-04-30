function evalUserInput(s) {
  return eval(s);
}

function safeProcess(s) {
  return JSON.parse(s);
}

function main() {
  const userInput = process.argv[2];
  evalUserInput(userInput);
  safeProcess(userInput);
}

module.exports = { evalUserInput, safeProcess, main };

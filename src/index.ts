import { createDefaultEngine } from './createDefaultEngine.js';

async function main(): Promise<void> {
  const engine = createDefaultEngine();

  const response = await engine.runTurn('帮我查一下上周的销售数据');
  console.log(response);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

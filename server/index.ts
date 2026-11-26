import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { listenUrls } from './network.js';

const config = loadConfig();
const { app } = await createApp(config, { instanceId: process.env.ODM_INSTANCE_ID });
// 后台服务不随启动终端的挂断信号退出。SIGTERM / SIGINT 仍执行正常关闭。
process.on('SIGHUP', () => app.log.info('SIGHUP received; detached service remains running'));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 15_000).unref();
  await app.close();
  clearTimeout(timeout);
  process.exit(0);
});
try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`OneDrive Manager (${config.host}:${config.port}):\n${listenUrls(config.host, config.port).join('\n')}`);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

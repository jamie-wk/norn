import { startProvider } from './provider.ts';

const provider = await startProvider({ port: Number(process.env.PORT ?? 4010), host: process.env.HOST ?? '0.0.0.0' });
console.log(`provider listening on ${provider.url}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void provider.close());

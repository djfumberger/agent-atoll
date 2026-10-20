// Same scanner and API as the city; serves the islands UI on its own port.
import { fileURLToPath } from 'node:url';
import { start } from '../server.mjs';

const port = await start({ port: Number(process.env.PORT || 4778), publicDir: fileURLToPath(new URL('./public', import.meta.url)) });
console.log(`Agent Atoll → http://localhost:${port}`);

// Removes compiled main-process output so deleted sources never linger in dist/.
import { rmSync } from 'node:fs';
for (const dir of ['dist/src', 'dist/tests']) rmSync(dir, { recursive: true, force: true });

/** Fixture: imports a banned specifier. The boot scan must quarantine it WITHOUT importing it. */

import { spawn } from 'node:child_process';

throw new Error('fixture banned: must never be imported');

export default spawn;

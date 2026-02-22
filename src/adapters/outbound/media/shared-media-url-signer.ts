import type { MediaUrlSignerPort } from '../../../application/profile/ports.js';
import { signMediaUrl } from '@mereb/shared-packages';

export class SharedMediaUrlSignerAdapter implements MediaUrlSignerPort {
  signMediaUrl(key: string): string {
    return signMediaUrl(key);
  }
}

import { randomUUID } from 'node:crypto';

export interface UserProfileRecord {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarKey: string | null;
  createdAt: Date;
}

export type AdminUserStatus = 'ACTIVE' | 'DEACTIVATED';

export interface AdminUserRecord extends UserProfileRecord {
  status: AdminUserStatus;
  deactivatedAt: Date | null;
}

export interface BootstrapUserDraft {
  id: string;
  preferredHandle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarKey?: string | null;
}

export interface UpdateProfilePatch {
  displayName?: string;
  bio?: string | null;
  avatarKey?: string | null;
}

export function deriveHandle(source: string): string {
  const normalised = source
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, '')
    .slice(0, 32);

  if (normalised.length > 2) {
    return normalised;
  }

  return `user_${randomUUID().slice(0, 8)}`;
}

export function buildBootstrapUserDraft(input: BootstrapUserDraft) {
  const { id, preferredHandle, displayName, bio = null, avatarKey = null } = input;
  const handleSource = preferredHandle ?? displayName ?? id;
  const handle = deriveHandle(handleSource);
  const safeDisplayName = (displayName ?? preferredHandle ?? handle).slice(0, 80);

  return {
    id,
    handle,
    displayName: safeDisplayName,
    bio,
    avatarKey
  };
}

export function buildProfileUpsertCreate(
  userId: string,
  patch: UpdateProfilePatch
): {
  id: string;
  handle: string;
  displayName: string;
  bio?: string | null;
  avatarKey: string | null;
} {
  return {
    id: userId,
    handle: deriveHandle(patch.displayName ?? userId),
    displayName: patch.displayName ?? 'New User',
    bio: patch.bio,
    avatarKey: patch.avatarKey ?? null
  };
}

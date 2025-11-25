import {randomUUID} from 'node:crypto';
import {prisma} from './prisma.js';

export type CreateUserInput = {
  id: string;
  preferredHandle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarKey?: string | null;
};

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

export async function createUserWithFallback(input: CreateUserInput) {
  const {
    id,
    preferredHandle,
    displayName,
    bio = null,
    avatarKey = null
  } = input;

  const handleSource = preferredHandle ?? displayName ?? id;
  const fallbackHandle = deriveHandle(handleSource);
  const safeDisplayName = (displayName ?? preferredHandle ?? fallbackHandle).slice(0, 80);

  try {
    return await prisma.user.create({
      data: {
        id,
        handle: fallbackHandle,
        displayName: safeDisplayName,
        bio,
        avatarKey
      }
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      const uniqueHandle = `${fallbackHandle}_${randomUUID().slice(0, 6)}`.slice(0, 32);
      return prisma.user.create({
        data: {
          id,
          handle: uniqueHandle,
          displayName: safeDisplayName,
          bio,
          avatarKey
        }
      });
    }

    throw error;
  }
}

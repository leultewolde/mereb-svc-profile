import {
  createProfileApplicationModule,
  type ProfileApplicationModule
} from '../application/profile/use-cases.js';
import { PrismaFollowRepository, PrismaUserRepository } from '../adapters/outbound/prisma/profile-prisma-repositories.js';
import { SharedMediaUrlSignerAdapter } from '../adapters/outbound/media/shared-media-url-signer.js';
import { createProfileEventPublisherAdapter } from '../adapters/outbound/events/profile-event-publisher.js';

export interface ProfileContainer {
  profile: ProfileApplicationModule;
}

export function createContainer(): ProfileContainer {
  const users = new PrismaUserRepository();
  const follows = new PrismaFollowRepository();
  const mediaUrlSigner = new SharedMediaUrlSignerAdapter();
  const eventPublisher = createProfileEventPublisherAdapter();

  const profile = createProfileApplicationModule({
    users,
    follows,
    profileRead: users,
    eventPublisher,
    mediaUrlSigner,
    eventProducerName: 'svc-profile'
  });

  return { profile };
}

import {
  createProfileApplicationModule,
  type ProfileApplicationModule
} from '../application/profile/use-cases.js';
import {
  PrismaFollowRepository,
  PrismaProfileOutboxEventPublisher,
  PrismaProfileTransactionRunner,
  PrismaUserRepository
} from '../adapters/outbound/prisma/profile-prisma-repositories.js';
import { SharedMediaUrlSignerAdapter } from '../adapters/outbound/media/shared-media-url-signer.js';
import { HttpMediaAssetResolverAdapter } from '../adapters/outbound/media/http-media-asset-resolver.js';

export interface ProfileContainer {
  profile: ProfileApplicationModule;
}

export function createContainer(): ProfileContainer {
  const users = new PrismaUserRepository();
  const follows = new PrismaFollowRepository();
  const mediaUrlSigner = new SharedMediaUrlSignerAdapter();
  const mediaAssetResolver = new HttpMediaAssetResolverAdapter();
  const eventPublisher = new PrismaProfileOutboxEventPublisher();
  const transactionRunner = new PrismaProfileTransactionRunner();

  const profile = createProfileApplicationModule({
    users,
    follows,
    profileRead: users,
    eventPublisher,
    mediaUrlSigner,
    mediaAssetResolver,
    eventProducerName: 'svc-profile',
    transactionRunner
  });

  return { profile };
}

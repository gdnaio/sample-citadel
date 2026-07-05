import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { IdentitySource, PlatformGroup, User } from '../types';
import { DEFAULT_GROUP } from '../policy/least-privilege';
import { DomainEventPublisher } from '../events/publisher';

export interface ProvisionUserInput {
  /** Cognito subject. */
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
  orgId: string;
  /** Resolved platform group; defaults to the least-privilege group. */
  platformGroup?: PlatformGroup;
  source?: IdentitySource;
}

export interface ProvisionResult {
  user: User;
  /** True when this call created the record; false when it already existed (idempotent). */
  created: boolean;
}

export interface UserProvisioningOptions {
  now?: () => Date;
  /** Optional publisher — a `UserProvisioned` event is emitted on first creation. */
  eventPublisher?: DomainEventPublisher;
}

/**
 * Just-in-time user provisioning for first SSO login (US-004, US-006a).
 *
 * Idempotent (PA2): concurrent/retried logins never create duplicate records.
 * New users default to the least-privilege group (US-006a); a `UserProvisioned`
 * domain event is published only on first creation.
 */
export class UserProvisioningService {
  private readonly now: () => Date;
  private readonly eventPublisher?: DomainEventPublisher;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: UserProvisioningOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.eventPublisher = options.eventPublisher;
  }

  async provision(input: ProvisionUserInput): Promise<ProvisionResult> {
    const timestamp = this.now().toISOString();
    const user: User = {
      sub: input.sub,
      email: input.email,
      givenName: input.givenName,
      familyName: input.familyName,
      orgId: input.orgId,
      status: 'active',
      platformGroup: input.platformGroup ?? DEFAULT_GROUP,
      source: input.source ?? 'federated',
      linkedProviders: [],
      provisionedAt: timestamp,
      lastLoginAt: timestamp,
    };

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: `USER#${user.sub}`, ...user },
          // Idempotent (PA2): only create if the user does not already exist.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return { user, created: false };
      }
      throw err;
    }

    if (this.eventPublisher) {
      await this.eventPublisher.publish({
        source: 'citadel.identity',
        detailType: 'UserProvisioned',
        detail: { sub: user.sub, orgId: user.orgId, platformGroup: user.platformGroup },
      });
    }

    return { user, created: true };
  }

  async getBySub(sub: string): Promise<User | undefined> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: `USER#${sub}` } }),
    );
    return res.Item as User | undefined;
  }
}

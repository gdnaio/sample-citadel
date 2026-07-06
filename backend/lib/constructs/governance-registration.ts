import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface GovernanceRegistrationProps {
  /** Deployment environment, used in the parameter name. */
  readonly environment: string;
  /** Capability / authority-unit slug being granted governance approval. */
  readonly capability?: string;
}

/**
 * Deploy-time governance registration for the team-management admin capability (US-019).
 *
 * Records the ADR / authority-unit grant as an SSM parameter under
 * `/citadel/governance/adr/...` — the platform's existing governance-state convention
 * (the arbiter governance engine reconciles these records). This is the concrete,
 * inspectable seam; the engine's reconciliation runs at/after deploy.
 */
export class GovernanceRegistration extends Construct {
  public readonly adrParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: GovernanceRegistrationProps) {
    super(scope, id);

    const capability = props.capability ?? 'team-management';

    this.adrParameter = new ssm.StringParameter(this, 'Adr', {
      parameterName: `/citadel/governance/adr/${capability}-${props.environment}`,
      description: `Governance ADR / authority-unit grant for the ${capability} capability (US-019).`,
      stringValue: JSON.stringify({
        adrId: `ADR-${capability}`,
        title: 'SSO team-management admin capability',
        status: 'ACCEPTED',
        authorityUnit: `authority:${capability}:admin`,
        decision:
          'Citadel Admins (Cognito `admin` group) may manage teams and team<->operational-unit mappings. ' +
          'Auto-mapping from external IdP groups never grants privileged groups such as `admin` (US-008).',
        stories: ['US-018', 'US-019', 'US-020'],
        recordedAtDeploy: true,
      }),
    });
  }
}

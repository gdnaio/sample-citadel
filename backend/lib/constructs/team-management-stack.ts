import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { TeamsTable } from "./teams-table";

export interface TeamManagementStackProps extends cdk.NestedStackProps {
  readonly environment: string;
  /** Parent AppSync API the team resolvers attach to. */
  readonly api: appsync.IGraphqlApi;
  /** Parent Cognito user pool (elevateRole → AdminAddUserToGroup). */
  readonly userPool: cognito.IUserPool;
  /** Shared `citadel-*` EventBridge bus (UserProvisioned in, MembershipChanged out). */
  readonly eventBus: events.IEventBus;
  /** Foundation audit table name (`citadel-identity-audit-{env}`), referenced by ARN. */
  readonly auditTableName: string;
}

/**
 * Unit B (Team & Operational-Unit Management) resources, isolated in a
 * NestedStack.
 *
 * WHY A NESTED STACK: the monolithic BackendStack is near CloudFormation's
 * 500-resource-per-template ceiling once SSO (oidcConfig) is enabled. The Unit B
 * wiring (TeamsTable + team-resolver + 14 AppSync resolvers + team-auto-join +
 * EventBridge rule ≈ 26 resources) tips the parent over 500. A NestedStack counts
 * as a single resource in the parent and carries its own resource budget, while
 * still deploying with BackendStack and referencing the parent's API, user pool,
 * and event bus via nested-stack cross-references. The opt-in gate is unchanged —
 * BackendStack only instantiates this when oidcConfig is present.
 */
export class TeamManagementStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: TeamManagementStackProps) {
    super(scope, id, props);

    const teamsTable = new TeamsTable(this, "TeamsTable", { environment: props.environment });
    const auditTableArn = `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${props.auditTableName}`;

    // team-resolver: admin-gated GraphQL resolvers (US-012/013/014/015).
    const teamResolverFunction = new lambda.Function(this, "TeamResolverFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "team-resolver.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      functionName: `citadel-team-resolver-${props.environment}`,
      environment: {
        TEAMS_TABLE: teamsTable.table.tableName,
        IDENTITY_AUDIT_TABLE: props.auditTableName,
        USER_POOL_ID: props.userPool.userPoolId,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "TeamResolverFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    teamsTable.table.grantReadWriteData(teamResolverFunction);
    // Audit-before-auth: append-only PutItem to the Foundation audit table (by ARN).
    teamResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [auditTableArn],
      }),
    );
    // elevateRole → AdminAddUserToGroup. Pseudo-parameter userpool ARN avoids the
    // UserPool<->consumer circular dependency (mirrors the pre-signup grant).
    teamResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminAddUserToGroup"],
        resources: [`arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/*`],
      }),
    );

    // Datasource + resolvers are scoped to THIS nested stack (constructed with
    // `this`), referencing the parent API — so they live in the nested template.
    const teamDataSource = new appsync.LambdaDataSource(this, "TeamLambdaDataSource", {
      api: props.api,
      lambdaFunction: teamResolverFunction,
      name: "TeamLambdaDataSource",
    });
    const teamQueryFields = [
      "listTeams", "getTeam", "listOperationalUnits", "listTeamMembers", "listTeamsForOperationalUnit",
    ];
    const teamMutationFields = [
      "createTeam", "renameTeam", "deleteTeam", "createOperationalUnit",
      "mapTeamToOperationalUnit", "unmapTeamFromOperationalUnit",
      "addTeamMember", "removeTeamMember", "elevateRole",
    ];
    for (const fieldName of teamQueryFields) {
      teamDataSource.createResolver(`TeamQuery_${fieldName}`, {
        typeName: "Query",
        fieldName,
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }
    for (const fieldName of teamMutationFields) {
      teamDataSource.createResolver(`TeamMutation_${fieldName}`, {
        typeName: "Mutation",
        fieldName,
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // team-auto-join: event-driven membership on citadel.identity.UserProvisioned
    // (US-006b). Graceful no-op until Unit A carries operationalUnits on the event.
    const teamAutoJoinFunction = new lambda.Function(this, "TeamAutoJoinFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "team-auto-join.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      functionName: `citadel-team-auto-join-${props.environment}`,
      environment: {
        TEAMS_TABLE: teamsTable.table.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "TeamAutoJoinFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    teamsTable.table.grantReadWriteData(teamAutoJoinFunction);
    props.eventBus.grantPutEventsTo(teamAutoJoinFunction);
    // DLQ + alarms are added in task 8.1 (operations).
    new events.Rule(this, "UserProvisionedAutoJoinRule", {
      eventBus: props.eventBus,
      eventPattern: { source: ["citadel.identity"], detailType: ["UserProvisioned"] },
      targets: [new targets.LambdaFunction(teamAutoJoinFunction)],
    });
  }
}

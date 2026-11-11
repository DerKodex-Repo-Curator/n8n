import { verifySignature } from '@n8n/utils/webhook-signature';
import get from 'lodash/get';
import type {
	DeclarativeSecretGenerator,
	DeclarativeWebhookCheckExists,
	DeclarativeWebhookCreate,
	DeclarativeWebhookDelete,
	DeclarativeWebhookHandshake,
	DeclarativeWebhookVerification,
	IDataObject,
	IDeclarativeWebhookTrigger,
	IHookFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeType,
	IWebhookFunctions,
	IWebhookResponseData,
	IWorkflowDataProxyAdditionalKeys,
	PostReceiveAction,
} from 'n8n-workflow';
import {
	createRunExecutionData,
	NodeApiError,
	NodeOperationError,
	UnexpectedError,
} from 'n8n-workflow';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { validateHeaderValue, type IncomingHttpHeaders } from 'node:http';

import { ExecuteSingleContext, HookContext, WebhookContext } from './node-execution-context';
import type { NodeExecutionContext } from './node-execution-context/node-execution-context';
import { runPostReceiveAction } from './post-receive';
import { runStandaloneRouting } from './standalone-routing';

type WebhookMethods = NonNullable<NonNullable<INodeType['webhookMethods']>['default']>;
type HookMethod = WebhookMethods['delete'];

const LOCALHOST_NAMES = ['localhost', '127.0.0.1', '[::1]'];

// A node with a function `create` has no `store`, so it lists its keys in `managedKeys`.
function clearManagedKeys(trigger: IDeclarativeWebhookTrigger, staticData: IDataObject) {
	const { create } = trigger.lifecycle;
	const keys = trigger.managedKeys ?? [
		...(typeof create === 'function' ? [] : Object.keys(create.store ?? {})),
		...Object.keys(trigger.handler?.handshake?.store ?? {}),
	];
	for (const key of keys) delete staticData[key];
}

type ResolveContext = Pick<NodeExecutionContext, 'workflow' | 'node' | 'mode'>;

// One pass only: response and request values that start with "=" stay literal strings.
const resolve = (
	context: ResolveContext,
	value: string,
	extraKeys: IWorkflowDataProxyAdditionalKeys,
) =>
	context.workflow.expression.getParameterValue(
		value,
		null,
		0,
		0,
		context.node.name,
		[],
		context.mode,
		extraKeys,
	);

/** Writes the `store` values to the static data. Returns the keys that resolved to `undefined`. */
function applyStore(
	context: ResolveContext,
	store: Record<string, string> | undefined,
	extraKeys: IWorkflowDataProxyAdditionalKeys,
	staticData: IDataObject,
) {
	const missing: string[] = [];
	for (const [key, value] of Object.entries(store ?? {})) {
		const resolved = resolve(context, value, extraKeys);
		if (resolved === undefined) missing.push(key);
		else staticData[key] = resolved;
	}
	return missing;
}

// Removes the stored hook before a new registration, so the provider does not keep both.
async function registerAgain(context: IHookFunctions, deleteHook?: HookMethod) {
	await deleteHook?.call(context);
	return false;
}

function hookContext(context: IHookFunctions) {
	if (!(context instanceof HookContext)) {
		throw new UnexpectedError('Declarative webhook trigger needs a HookContext');
	}
	const staticData = context.getWorkflowStaticData('node');
	const extraKeys: IWorkflowDataProxyAdditionalKeys = {
		$webhookUrl: context.getNodeWebhookUrl('default'),
		$staticData: staticData,
	};
	return { context, staticData, extraKeys };
}

function createCheckExists(
	nodeType: INodeType,
	trigger: IDeclarativeWebhookTrigger,
	config: DeclarativeWebhookCheckExists,
	deleteHook?: HookMethod,
): WebhookMethods['checkExists'] {
	return async function (this: IHookFunctions) {
		const { context, staticData, extraKeys } = hookContext(this);

		// A hook without a required value, such as its secret, cannot serve deliveries.
		if (config.requireKeys?.some((key) => !staticData[key])) {
			return await registerAgain(context, deleteHook);
		}

		if (config.matchOn) {
			const hooks = await runStandaloneRouting(context, nodeType, config.routing, extraKeys);
			for (const { json } of hooks) {
				const hookKeys = { ...extraKeys, $hook: json };
				const matches = config.matchOn.every(
					({ itemProperty, value }) =>
						get(json, itemProperty) === resolve(context, value, hookKeys),
				);
				if (matches) {
					applyStore(context, config.store, hookKeys, staticData);
					return true;
				}
			}
			return false;
		}

		if (staticData[config.idKey ?? 'webhookId'] === undefined) return false;
		try {
			await runStandaloneRouting(context, nodeType, config.routing, extraKeys);
			return true;
		} catch (error) {
			const notFound = config.notFoundHttpCodes ?? [404];
			if (error instanceof NodeApiError && notFound.includes(Number(error.httpCode))) {
				clearManagedKeys(trigger, staticData);
				return false;
			}
			throw error;
		}
	};
}

const ALPHANUMERIC_LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateSecret({ type, length, prefix = '' }: DeclarativeSecretGenerator) {
	switch (type) {
		case 'hex':
			return prefix + randomBytes(length ?? 32).toString('hex');
		case 'base64':
			return prefix + randomBytes(length ?? 32).toString('base64');
		case 'uuid':
			return prefix + randomUUID();
		case 'alphanumericLower': {
			const chars = Array.from(
				{ length: length ?? 10 },
				() => ALPHANUMERIC_LOWER[randomInt(ALPHANUMERIC_LOWER.length)],
			);
			return prefix + chars.join('');
		}
	}
}

function createCreate(
	nodeType: INodeType,
	trigger: IDeclarativeWebhookTrigger,
	config: DeclarativeWebhookCreate,
	deleteHook?: HookMethod,
): WebhookMethods['create'] {
	return async function (this: IHookFunctions) {
		const { context, staticData, extraKeys } = hookContext(this);
		const url = extraKeys.$webhookUrl;

		if (config.rejectLocalhostUrl && url && LOCALHOST_NAMES.includes(new URL(url).hostname)) {
			throw new NodeOperationError(
				context.getNode(),
				'The webhook cannot work on "localhost". Set up n8n on a custom domain.',
			);
		}

		const $generated: Record<string, string> = {};
		for (const [name, generator] of Object.entries(config.generate ?? {})) {
			if (generator.length !== undefined && generator.length < 1) {
				throw new NodeOperationError(
					context.getNode(),
					`The length of the generated value "${name}" must be 1 or more`,
				);
			}
			$generated[name] = generateSecret(generator);
		}
		const requestKeys = { ...extraKeys, $generated };

		// A new hook gets a new handshake. An old value would block it, because a handshake fills only empty keys.
		for (const key of Object.keys(trigger.handler?.handshake?.store ?? {})) delete staticData[key];

		const [response] = await runStandaloneRouting(context, nodeType, config.routing, requestKeys);
		const $response = response?.json ?? {};
		const responseKeys = { ...requestKeys, $response };

		const valid =
			!config.validateResponse || resolve(context, config.validateResponse, responseKeys);
		const missing = applyStore(context, config.store, responseKeys, staticData);
		if (!valid || missing.length > 0) {
			// The provider has the hook now. Remove it, so the next activation does not add a second one.
			await deleteHook?.call(context);
			// Only the keys: the response can contain a signing secret.
			throw new NodeOperationError(
				context.getNode(),
				'The webhook registration response does not contain the expected data',
				{ description: `Response keys: ${Object.keys($response).join(', ')}` },
			);
		}
		return true;
	};
}

function createDelete(
	nodeType: INodeType,
	trigger: IDeclarativeWebhookTrigger,
	config: DeclarativeWebhookDelete,
): WebhookMethods['delete'] {
	return async function (this: IHookFunctions) {
		const { context, staticData, extraKeys } = hookContext(this);
		if (staticData[config.idKey ?? 'webhookId'] === undefined) return true;
		try {
			await runStandaloneRouting(context, nodeType, config.routing, extraKeys);
		} catch (error) {
			// Deactivation must not fail. Keep the static data, so a later delete can try again.
			context.logger.warn(`Could not deregister the webhook of node "${context.node.name}"`, {
				workflowId: context.workflow.id,
				error,
			});
			return false;
		}
		clearManagedKeys(trigger, staticData);
		return true;
	};
}

/** Builds `webhookMethods.default` for a node with `trigger: { type: 'webhook' }`. */
export function createDeclarativeWebhookMethods(
	nodeType: INodeType,
	trigger: IDeclarativeWebhookTrigger,
): WebhookMethods {
	const { checkExists, create, delete: del } = trigger.lifecycle;
	const deleteHook = typeof del === 'object' ? createDelete(nodeType, trigger, del) : undefined;
	return {
		checkExists:
			typeof checkExists === 'object'
				? createCheckExists(nodeType, trigger, checkExists, deleteHook)
				: (checkExists ??
					async function (this: IHookFunctions) {
						return await registerAgain(this, deleteHook);
					}),
		create:
			typeof create === 'object' ? createCreate(nodeType, trigger, create, deleteHook) : create,
		delete: deleteHook ?? (typeof del === 'function' ? del : async () => true),
	};
}

/** Shapes the items with `postReceive` actions. The request stands in for the response. */
async function shapeItems(
	context: WebhookContext,
	actions: PostReceiveAction[],
	items: INodeExecutionData[],
	request: NonNullable<IWorkflowDataProxyAdditionalKeys['$webhookRequest']>,
) {
	const { workflow, node, additionalData, mode } = context;
	const response: IN8nHttpFullResponse = {
		body: request.body,
		headers: request.headers,
		statusCode: 200,
	};
	const extraKeys = { $webhookRequest: request };
	const executeSingleContext = new ExecuteSingleContext(
		workflow,
		node,
		additionalData,
		mode,
		createRunExecutionData(),
		0,
		[],
		{ main: [[{ json: {} }]] },
		0,
		{ node, data: {}, source: null },
	);
	for (const action of actions) {
		items = await runPostReceiveAction(
			executeSingleContext,
			action,
			items,
			response,
			undefined,
			0,
			0,
			{
				node,
				// One pass, as in `resolve`. The keys of the action win over the extra keys.
				resolveValue: (value, itemIndex, runIndex, actionExecuteData, additionalKeys) =>
					workflow.expression.getParameterValue(
						value,
						null,
						runIndex,
						itemIndex,
						node.name,
						[],
						mode,
						{ ...extraKeys, ...additionalKeys },
						actionExecuteData,
					),
				getCredentials: async () => undefined,
			},
		);
	}
	return items;
}

/** Writes `store`, sets the configured reply and starts no workflow. */
function respondToHandshake(
	context: WebhookContext,
	handshake: DeclarativeWebhookHandshake,
	extraKeys: IWorkflowDataProxyAdditionalKeys,
): IWebhookResponseData {
	const staticData = context.getWorkflowStaticData('node');
	// Fill only empty keys, so a later handshake does not replace a stored value. Concurrent requests are not atomic: the last save wins.
	const store = Object.entries(handshake.store ?? {}).filter(([key]) => !staticData[key]);
	applyStore(context, Object.fromEntries(store), extraKeys, staticData);

	const { body, statusCode = 200, contentType, headers = {} } = handshake.respond ?? {};
	const res = context.getResponseObject();
	for (const [name, value] of Object.entries(headers)) {
		const header = resolve(context, value, extraKeys);
		const text = typeof header === 'string' ? header : JSON.stringify(header);
		try {
			// Skip a missing or invalid value, as the server does for response headers.
			validateHeaderValue(name, text);
		} catch {
			continue;
		}
		res.setHeader(name, text);
	}
	if (contentType) res.setHeader('content-type', contentType);
	const resolved = body === undefined ? 'OK' : resolve(context, body, extraKeys);
	// With `undefined`, the server would send its default message.
	const value = resolved === undefined ? '' : resolved;
	// The server replies after it saves the static data, so the vendor cannot send a delivery before the value is stored.
	if (statusCode === 200) return { webhookResponse: value };

	// The server sets the status of the route, so another status needs a direct reply.
	res.status(statusCode);
	// The same rule as the server reply: a string is sent as it is, other values as JSON.
	if (typeof value === 'string') res.send(value);
	else res.json(value);
	return { noWebhookResponse: true };
}

/** Builds the signed bytes. The raw body is added after the template resolves, so it is never an expression. */
function signedPayload(
	context: WebhookContext,
	template: string,
	extraKeys: IWorkflowDataProxyAdditionalKeys,
) {
	const { rawBody } = context.getRequestObject();
	if (!Buffer.isBuffer(rawBody)) return null;
	const isExpression = template.startsWith('=');
	const parts: Buffer[] = [];
	const texts = (isExpression ? template.slice(1) : template).split('{body}');
	for (const [index, part] of texts.entries()) {
		if (index > 0) parts.push(rawBody);
		const value = isExpression && part ? resolve(context, `=${part}`, extraKeys) : part;
		const text = typeof value === 'number' ? String(value) : value;
		if (typeof text !== 'string') return null;
		parts.push(Buffer.from(text));
	}
	return Buffer.concat(parts);
}

const headerValue = (headers: IncomingHttpHeaders, name: string) => {
	// Node gives header names in lowercase.
	const value = headers[name.toLowerCase()];
	return typeof value === 'string' ? value : null;
};

/** Checks the signature of a delivery. No secret fails the check, unless `skipIfNoSecret` is set. */
async function verifyDelivery(
	context: WebhookContext,
	config: DeclarativeWebhookVerification | undefined,
	extraKeys: IWorkflowDataProxyAdditionalKeys,
) {
	if (!config) return true;
	const headers = context.getHeaderData();
	const { credentialType } = config;
	let secret: unknown;
	try {
		// Only a credential that is not set counts as no secret. A credential that does not load fails the check.
		const credentials =
			credentialType && context.node.credentials?.[credentialType]
				? await context.getCredentials(credentialType)
				: undefined;
		secret = resolve(context, config.secret, {
			...extraKeys,
			$staticData: context.getWorkflowStaticData('node'),
			$credentials: credentials,
		});
	} catch {
		// The error can contain the secret, so the log has only the node name.
		context.logger.warn(
			`Webhook trigger "${context.node.name}" rejected a delivery because its signature secret could not be loaded`,
			{ workflowId: context.workflow.id },
		);
		return false;
	}
	if (secret === undefined || secret === null || secret === '') {
		if (config.skipIfNoSecret) return true;
		// A handshake key stays empty until the vendor sends the handshake.
		context.logger.warn(
			`Webhook trigger "${context.node.name}" rejected a delivery because no signature secret is available`,
			{ workflowId: context.workflow.id },
		);
		return false;
	}
	if (typeof secret !== 'string') return false;

	const { algorithm, prefix = '', timestampHeader } = config;
	return verifySignature({
		getExpectedSignature: () => {
			if (algorithm === 'token') return prefix + secret;
			const payload = signedPayload(context, config.signedPayload ?? '{body}', extraKeys);
			if (!payload) return null;
			const hmac = createHmac(algorithm === 'hmac-sha1' ? 'sha1' : 'sha256', secret);
			return prefix + hmac.update(payload).digest(config.encoding ?? 'hex');
		},
		getActualSignature: () => headerValue(headers, config.signatureHeader),
		getTimestamp: timestampHeader ? () => headerValue(headers, timestampHeader) : undefined,
		maxTimestampAgeSeconds: config.maxTimestampAgeSeconds,
	});
}

/** Builds the default `webhook()` of a declarative webhook trigger. Stage order: handshake, verification, ping, filter, output. */
export function createDeclarativeWebhook(trigger: IDeclarativeWebhookTrigger) {
	const { handshake, verification, ping, filter, output } = trigger.handler ?? {};
	return async function (this: IWebhookFunctions): Promise<IWebhookResponseData> {
		if (!(this instanceof WebhookContext)) {
			throw new UnexpectedError('Declarative webhook trigger needs a WebhookContext');
		}
		const body = this.getBodyData();
		const headers = this.getHeaderData();
		const query = this.getQueryData();
		const request = { body, headers, query };
		const extraKeys: IWorkflowDataProxyAdditionalKeys = { $webhookRequest: request };

		if (this.getWebhookName() === 'setup') {
			if (handshake?.when !== undefined && !resolve(this, handshake.when, extraKeys)) {
				this.getResponseObject().status(401).send('Unauthorized');
				return { noWebhookResponse: true };
			}
			return respondToHandshake(this, handshake ?? {}, extraKeys);
		}

		if (handshake?.when !== undefined && resolve(this, handshake.when, extraKeys)) {
			return respondToHandshake(this, handshake, extraKeys);
		}

		if (!(await verifyDelivery(this, verification, extraKeys))) {
			this.getResponseObject().status(401).send('Unauthorized');
			return { noWebhookResponse: true };
		}

		if (ping && resolve(this, ping.when, extraKeys)) {
			return {
				webhookResponse:
					ping.response === undefined ? 'OK' : resolve(this, ping.response, extraKeys),
			};
		}

		if (filter) {
			const allowedValue = resolve(this, filter.allowed, extraKeys);
			const allowed: unknown[] = Array.isArray(allowedValue) ? allowedValue : [allowedValue];
			const wildcard = filter.wildcard !== undefined && allowed.includes(filter.wildcard);
			const actual = resolve(this, filter.actual, extraKeys);
			// No `workflowData`: the server replies 200 and starts no workflow.
			if (!wildcard && (actual === undefined || !allowed.includes(actual))) return {};
		}

		// Not `returnJsonArray`: a body key such as `json` or `binary` must not shape the item.
		const elements: IDataObject[] = Array.isArray(body) ? body : [body];
		let items: INodeExecutionData[] = elements.map((json) => ({ json }));
		if (output?.postReceive?.length) {
			items = await shapeItems(this, output.postReceive, items, request);
		}
		if (output?.includeMeta) {
			// The spread keeps binary data that a postReceive action attached.
			items = items.map((item) => ({ ...item, json: { body: item.json, headers, query } }));
		}
		// An empty result starts no workflow, the same as a filter miss.
		if (items.length === 0) return {};
		return { workflowData: [items] };
	};
}

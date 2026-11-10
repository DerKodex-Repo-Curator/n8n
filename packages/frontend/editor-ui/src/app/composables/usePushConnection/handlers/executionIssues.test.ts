import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';
import { stringify } from 'flatted';
import type { ExecutionStarted } from '@n8n/api-types/push/execution';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { createTestNode, createTestTaskData } from '@/__tests__/mocks';
import { executionStarted } from './executionStarted';
import { nodeExecuteAfter } from './nodeExecuteAfter';
import { executionFinished } from './executionFinished';
import type { PushHandlerOptions } from './types';

vi.mock('@/app/composables/useWorkflowId', async () => {
	const { computed } = await import('vue');
	return {
		useWorkflowId: () => computed(() => ''),
		useRouteWorkflowId: () => computed(() => ''),
	};
});

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/composables/useDocumentTitle', () => ({
	useDocumentTitle: () => ({ setDocumentTitle: vi.fn() }),
}));

describe('node execution issues across a partial run', () => {
	const WORKFLOW_ID = 'wf-1';
	const EXECUTION_ID = 'exec-2';
	const AGENT = 'Agent';
	const documentId = createWorkflowDocumentId(WORKFLOW_ID);
	const options: PushHandlerOptions = { router: mock<Router>(), documentId };

	function agentExecutionIssue(): boolean | undefined {
		return useWorkflowDocumentStore(documentId).getNodeByName(AGENT)?.issues?.execution;
	}

	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
		useWorkflowsStore().setWorkflowId(WORKFLOW_ID);

		const workflowDocumentStore = useWorkflowDocumentStore(documentId);
		workflowDocumentStore.addNode(createTestNode({ name: 'Make Notes' }));
		workflowDocumentStore.addNode(createTestNode({ name: AGENT }));
		workflowDocumentStore.setNodeIssue({ node: AGENT, type: 'execution', value: true });

		useWorkflowExecutionStateStore(documentId).setActiveExecutionId(null);
	});

	it('leaves no execution issue on a node that succeeded in an unsaved partial run', async () => {
		vi.spyOn(useWorkflowsStore(), 'fetchExecutionDataById').mockResolvedValue(null);

		await executionStarted(
			{
				type: 'executionStarted',
				data: {
					executionId: EXECUTION_ID,
					workflowId: WORKFLOW_ID,
					flattedRunData: stringify({ 'Make Notes': [createTestTaskData()] }),
				} as ExecutionStarted['data'],
			},
			options,
		);
		await nodeExecuteAfter(
			{
				type: 'nodeExecuteAfter',
				data: {
					executionId: EXECUTION_ID,
					nodeName: AGENT,
					sequenceNumber: 1,
					itemCountByConnectionType: { main: [1] },
					data: {
						executionTime: 5,
						startTime: 0,
						executionIndex: 1,
						source: [],
						executionStatus: 'success',
					},
				},
			},
			options,
		);
		await executionFinished(
			{
				type: 'executionFinished',
				data: { executionId: EXECUTION_ID, workflowId: WORKFLOW_ID, status: 'success' },
			},
			options,
		);

		expect(agentExecutionIssue()).toBeUndefined();
	});
});

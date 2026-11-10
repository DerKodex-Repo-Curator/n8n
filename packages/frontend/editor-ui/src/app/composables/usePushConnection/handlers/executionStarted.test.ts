import { createPinia, setActivePinia } from 'pinia';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';
import { stringify } from 'flatted';
import type { ExecutionError, IRunData } from 'n8n-workflow';
import { executionStarted } from './executionStarted';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import type { ExecutionStarted } from '@n8n/api-types/push/execution';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { createTestNode, createTestTaskData } from '@/__tests__/mocks';
import type { PushHandlerOptions } from './types';

describe('executionStarted', () => {
	const documentId = createWorkflowDocumentId('wf-123');
	let options: PushHandlerOptions;
	let workflowExecutionStateStore: ReturnType<typeof useWorkflowExecutionStateStore>;

	function makeEvent(executionId = 'exec-1', workflowId = 'wf-123'): ExecutionStarted {
		return {
			type: 'executionStarted',
			data: { executionId, workflowId } as ExecutionStarted['data'],
		};
	}

	beforeEach(() => {
		setActivePinia(createPinia());

		options = { router: mock<Router>(), documentId };

		const workflowDocumentStore = useWorkflowDocumentStore(documentId);
		workflowDocumentStore.setName('My Workflow');
		useWorkflowsStore().setWorkflowId('wf-123');

		workflowExecutionStateStore = useWorkflowExecutionStateStore(documentId);
	});

	describe('node execution issues', () => {
		const AGENT = 'Agent';
		const FAILED_TASK = createTestTaskData({
			executionStatus: 'error',
			error: { message: 'invalid x-api-key' } as ExecutionError,
		});

		function agentExecutionIssue(): boolean | undefined {
			return useWorkflowDocumentStore(documentId).getNodeByName(AGENT)?.issues?.execution;
		}

		async function startWithRunData(runData: IRunData): Promise<void> {
			await executionStarted(
				{
					type: 'executionStarted',
					data: {
						executionId: 'exec-1',
						workflowId: 'wf-123',
						flattedRunData: stringify(runData),
					} as ExecutionStarted['data'],
				},
				options,
			);
		}

		beforeEach(() => {
			const workflowDocumentStore = useWorkflowDocumentStore(documentId);
			workflowDocumentStore.addNode(createTestNode({ name: AGENT }));
			workflowDocumentStore.setNodeIssue({ node: AGENT, type: 'execution', value: true });
			workflowExecutionStateStore.setActiveExecutionId(null);
		});

		it('keeps a node execution issue when the started run data has a failed task for the node', async () => {
			await startWithRunData({ [AGENT]: [FAILED_TASK] });

			expect(agentExecutionIssue()).toBe(true);
		});

		it('clears a node execution issue when the started run data has no task for the node', async () => {
			await startWithRunData({ 'Make Notes': [createTestTaskData()] });

			expect(agentExecutionIssue()).toBeUndefined();
		});
	});

	it('should skip when activeExecutionId is undefined', async () => {
		// activeExecutionId defaults to undefined, no need to set it
		await executionStarted(makeEvent(), options);

		// workflowExecutionStateStore.activeExecutionId should remain undefined
		expect(workflowExecutionStateStore.activeExecutionId).toBeUndefined();

		// No execution data store should have been created for exec-1
		const executionDataStore = useExecutionDataStore(createExecutionDataId('exec-1'));
		expect(executionDataStore.execution).toBeNull();
	});

	it('should accept execution when activeExecutionId is null and populate workflowData from store', async () => {
		workflowExecutionStateStore.setActiveExecutionId(null);

		await executionStarted(makeEvent('exec-1'), options);

		expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-1');

		const executionDataStore = useExecutionDataStore(createExecutionDataId('exec-1'));
		expect(executionDataStore.execution).toMatchObject({
			id: 'exec-1',
			status: 'running',
			workflowData: expect.objectContaining({ id: 'wf-123', name: 'My Workflow' }),
		});
	});

	it('should skip when the event workflow id does not match the document', async () => {
		// A pending run is staged for this document...
		workflowExecutionStateStore.setActiveExecutionId(null);

		// ...but the event belongs to a different workflow (e.g. a concurrent
		// scheduled run). It must not hijack this document's pending slot.
		await executionStarted(makeEvent('exec-9', 'other-wf'), options);

		expect(workflowExecutionStateStore.activeExecutionId).toBeNull();
		expect(useExecutionDataStore(createExecutionDataId('exec-9')).execution).toBeNull();
	});

	it('should accept when the event workflow id matches the document', async () => {
		workflowExecutionStateStore.setActiveExecutionId(null);

		await executionStarted(makeEvent('exec-1', 'wf-123'), options);

		expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-1');
	});

	it('should not reinitialize when same execution ID arrives', async () => {
		// Set up an active execution with existing data
		workflowExecutionStateStore.promotePendingExecution('exec-1');
		const executionDataStore = useExecutionDataStore(createExecutionDataId('exec-1'));
		executionDataStore.setExecution({
			id: 'exec-1',
			finished: false,
			mode: 'manual',
			status: 'running',
			createdAt: new Date(),
			startedAt: new Date(),
			workflowData: { id: 'wf-123', name: 'My Workflow', nodes: [], connections: {} } as never,
			data: { resultData: { runData: {} } } as never,
		});

		const executionBefore = executionDataStore.execution;

		await executionStarted(makeEvent('exec-1'), options);

		// workflowExecutionStateStore.activeExecutionId should remain 'exec-1' without change
		expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-1');

		// execution data should not have been overwritten (same reference or same id)
		expect(executionDataStore.execution?.id).toBe('exec-1');
		// status should remain the same (not reinitialised)
		expect(executionDataStore.execution?.status).toBe(executionBefore?.status);
	});

	describe('iframe re-execution', () => {
		const originalParent = window.parent;

		beforeEach(() => {
			// Simulate iframe context: window.parent differs from window
			Object.defineProperty(window, 'parent', {
				value: { postMessage: vi.fn() },
				writable: true,
				configurable: true,
			});
		});

		afterEach(() => {
			Object.defineProperty(window, 'parent', {
				value: originalParent,
				writable: true,
				configurable: true,
			});
		});

		it('should accept execution when activeExecutionId is undefined in iframe (post-executionFinished)', async () => {
			// activeExecutionId defaults to undefined; in iframe context this should still accept
			await executionStarted(makeEvent('exec-2'), options);

			expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-2');

			const executionDataStore = useExecutionDataStore(createExecutionDataId('exec-2'));
			expect(executionDataStore.execution).toMatchObject({
				id: 'exec-2',
				status: 'running',
			});
		});

		it('should accept new execution and reset state when re-executing in iframe', async () => {
			// Set up an existing active execution
			workflowExecutionStateStore.promotePendingExecution('exec-1');
			const oldExecStore = useExecutionDataStore(createExecutionDataId('exec-1'));
			oldExecStore.setExecution({
				id: 'exec-1',
				finished: false,
				mode: 'manual',
				status: 'running',
				createdAt: new Date(),
				startedAt: new Date(),
				workflowData: { id: 'wf-123', name: 'My Workflow', nodes: [], connections: {} } as never,
				data: {
					resultData: { runData: { Node1: [{ executionTime: 100 }] } },
				} as never,
			});

			await executionStarted(makeEvent('exec-2'), options);

			expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-2');

			const newExecStore = useExecutionDataStore(createExecutionDataId('exec-2'));
			expect(newExecStore.execution).toMatchObject({
				id: 'exec-2',
				status: 'running',
			});
		});

		it('should not reset when same execution ID arrives in iframe', async () => {
			// Set up an existing active execution with data
			workflowExecutionStateStore.promotePendingExecution('exec-1');
			const executionDataStore = useExecutionDataStore(createExecutionDataId('exec-1'));
			executionDataStore.setExecution({
				id: 'exec-1',
				finished: false,
				mode: 'manual',
				status: 'running',
				createdAt: new Date(),
				startedAt: new Date(),
				workflowData: { id: 'wf-123', name: 'My Workflow', nodes: [], connections: {} } as never,
				data: { resultData: { runData: {} } } as never,
			});

			await executionStarted(makeEvent('exec-1'), options);

			// Should remain exec-1 without reinitializing
			expect(workflowExecutionStateStore.activeExecutionId).toBe('exec-1');
		});
	});
});

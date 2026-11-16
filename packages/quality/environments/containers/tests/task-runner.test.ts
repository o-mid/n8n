import { describe, expect, test } from 'vitest';

import { taskRunner } from '../services/task-runner';
import type { StartContext } from '../services/types';

const context = (topology: { mains: number; workers: number }) =>
	({
		...topology,
		isQueueMode: topology.mains > 1 || topology.workers > 0,
		projectName: 'proj',
		external: false,
		config: {},
	}) as unknown as StartContext;

describe('task runner service', () => {
	test('starts for a single main, which runs the task broker', () => {
		expect(taskRunner.shouldStart?.(context({ mains: 1, workers: 0 }))).toBe(true);
	});

	test('starts for a worker, which runs the task broker in queue mode', () => {
		expect(taskRunner.shouldStart?.(context({ mains: 2, workers: 1 }))).toBe(true);
	});

	test('stays off for more than one main without a worker, since no process runs a task broker', () => {
		expect(taskRunner.shouldStart?.(context({ mains: 2, workers: 0 }))).toBe(false);
	});

	test.each([
		[{ mains: 1, workers: 0 }, 'http://proj-n8n:5679'],
		[{ mains: 2, workers: 1 }, 'http://proj-n8n-worker-1:5679'],
	])('dials the task broker of %o at %s', (topology, taskBrokerUri) => {
		expect(taskRunner.getOptions?.(context(topology))).toEqual({ taskBrokerUri });
	});
});

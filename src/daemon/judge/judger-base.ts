import { TestData, SubtaskScoringType, TestcaseJudge, SubtaskJudge } from '../interfaces';
import { CompilationResult, JudgeResult, TaskStatus, SubtaskResult, TestcaseDetails, TestcaseResultType } from '../../interfaces';
import { Language } from '../../languages';
import { compile } from './compile';
import winston = require('winston');
import _ = require('lodash');
import { globalConfig } from '../config';

const globalFullScore = 100;
function calculateSubtaskScore(scoring: SubtaskScoringType, scores: number[]): number {
    if (scoring === SubtaskScoringType.Minimum) {
        return _.min(scores);
    } else if (scoring === SubtaskScoringType.Multiple) {
        return _.reduce(scores,
            (res, cur) => res * cur, 1);
    } else if (scoring === SubtaskScoringType.Summation) {
        return _.sum(scores) / scores.length;
    }
}

export abstract class JudgerBase {
    priority: number;
    testData: TestData;
    subtaskResults?: SubtaskResult[];

    constructor(t: TestData, p: number) {
        this.priority = p;
        this.testData = t;
    }

    async preprocessTestData(): Promise<void> { }

    abstract compile(): Promise<CompilationResult>;
    protected compileWithDiagnostics(): Promise<CompilationResult> {
        throw new Error("Diagnostics not supported.");
    }

    // Toposort subtask dependencies.
    getSubtaskOrder(subtasks: SubtaskJudge[]): number[] {
        const fatal = (message) => {
            throw new Error("Misconfigured subtask dependencies: " + message);
        };

        const queue: number[] = [];
        const edgesOut: number[][] = subtasks.map(() => []);

        const degreeIn = subtasks.map(({ type, dependencies }, index) => {
            if (!Array.isArray(dependencies))
                fatal("field 'dependencies' must be array");
            
            if (dependencies.length > 0) {
                if (type !== SubtaskScoringType.Minimum)
                    fatal("subtask with dependencies must have scoring type 'min'");
            } else {
                queue.push(index);
            }

            for (const from of dependencies) {
                if (!Number.isInteger(from))
                    fatal("subtask index must be integer");
                if (from < 0 || from >= subtasks.length)
                    fatal("subtask index out of range");
                if (subtasks[from].type !== SubtaskScoringType.Minimum)
                    fatal("subtask with dependencies must have scoring type 'min'");
                edgesOut[from].push(index);
            }

            return dependencies.length;
        });

        for (let head = 0; head < queue.length; head++) {
            const index = queue[head];
            for (const to of edgesOut[index]) {
                degreeIn[to]--;
                if (0 === degreeIn[to]) queue.push(to);
            }
        }

        if (queue.length < subtasks.length)
            fatal("loop detected");

        return queue;
    }

    async judge(reportProgressResult: (p: JudgeResult) => Promise<void>): Promise<JudgeResult> {
        const results: SubtaskResult[] = this.testData.subtasks.map(t => ({
            cases: t.cases.map(j => ({
                status: TaskStatus.Waiting,
                result: { scoringRate: t.type !== SubtaskScoringType.Summation ? 1 : 0 } as any
            })),
            status: TaskStatus.Waiting
        }));
        this.subtaskResults = results;

        const updateSubtaskScore = (currentTask, currentResult) => {
            if (currentResult.cases.some(c => c.status === TaskStatus.Failed)) {
                // If any testcase has failed, the score is invaild.
                currentResult.score = NaN;
            } else {
                currentResult.score = calculateSubtaskScore(currentTask.type, currentResult.cases.map(c => c.result ? c.result.scoringRate : 0)) * currentTask.score;
            }
        }

        const testcaseDetailsCache: Map<string, TestcaseDetails> = new Map();
        const judgeTestcaseWrapper = async (curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails> => {
            if (testcaseDetailsCache.has(curCase.name)) {
                return testcaseDetailsCache.get(curCase.name);
            }

            const result: TestcaseDetails = await this.judgeTestcase(curCase, started);
            testcaseDetailsCache.set(curCase.name, result);

            return result;
        }

        for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; subtaskIndex++) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];
            updateSubtaskScore(currentTask, currentResult);
        }

        const reportProgress = function () {
            reportProgressResult({ subtasks: results });
        }
        winston.debug(`Totally ${results.length} subtasks.`);

        const subtaskOrder = this.getSubtaskOrder(this.testData.subtasks);
        const judgeTasks: Promise<void>[] = new Array(results.length).fill(null);

        winston.debug('Subtask order: ' + subtaskOrder.join(', '));

        for (let subtaskIndex of subtaskOrder) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];

            let updateCurrentSubtaskScore = () => updateSubtaskScore(currentTask, currentResult);

            judgeTasks[subtaskIndex] = (async () => {
                const { dependencies } = currentTask;

                if (dependencies.length) {
                    // Wait for dependencies
                    await Promise.all(dependencies.map(index => judgeTasks[index]));
                }

                if (currentTask.type !== SubtaskScoringType.Summation) {
                    // Type minimum is skippable, run one by one
                    let skipped = false;

                    if (currentTask.type === SubtaskScoringType.Minimum) {
                        const minRatio = _.min(dependencies.map(index => {
                            const realScore = results[index].score;
                            const fullScore = this.testData.subtasks[index].score;
                            return realScore / fullScore;
                        }).concat(1));
                        
                        const minScore = minRatio * currentTask.score;
                        if (!(minScore > 0)) skipped = true;

                        winston.debug(`Subtask ${subtaskIndex}: min_score = ${minScore}`);

                        const oldHandler = updateCurrentSubtaskScore;
                        updateCurrentSubtaskScore = () => {
                            oldHandler();
                            currentResult.score = Math.min(currentResult.score, minScore);
                        };
                    }

                    for (let index = 0; index < currentTask.cases.length; index++) {
                        const currentTaskResult = currentResult.cases[index];
                        if (skipped) {
                            currentTaskResult.status = TaskStatus.Skipped;
                        } else {
                            winston.verbose(`Judging ${subtaskIndex}, case ${index}.`);
                            let score = 0;
                            try {
                                const taskJudge = await judgeTestcaseWrapper(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                                currentTaskResult.result = taskJudge;
                                score = taskJudge.scoringRate;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            if (score == null || isNaN(score) || score === 0) {
                                winston.debug(`Subtask ${subtaskIndex}, case ${index}: zero, skipping the rest.`);
                                skipped = true;
                            }
                            updateCurrentSubtaskScore();
                            await reportProgress();
                        }
                    }
                } else {
                    // Non skippable, run all immediately
                    const caseTasks: Promise<void>[] = [];
                    for (let index = 0; index < currentTask.cases.length; index++) {
                        caseTasks.push((async () => {
                            const currentTaskResult = currentResult.cases[index];
                            winston.verbose(`Judging ${subtaskIndex}, case ${index}.`);
                            try {
                                currentTaskResult.result = await judgeTestcaseWrapper(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            updateCurrentSubtaskScore();
                            await reportProgress();
                        })());
                    }
                    await Promise.all(caseTasks);
                }
                updateCurrentSubtaskScore();
                await reportProgress();
                winston.verbose(`Subtask ${subtaskIndex} finished, score = ${currentTask.score}`);
            })();
        }
        await Promise.all(judgeTasks);

        // Let's check whether this submission supports diagnostics first.
        if (globalConfig.diagnostics.enabled && this.supportDiagnostics()) {
            winston.verbose('Diagnostics supported.');
            await this.runDiagnostics(reportProgress);
        }

        return { subtasks: results };
    }
    protected abstract judgeTestcase(curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails>;

    supportDiagnostics(): boolean {
        return false;
    }
    async runDiagnostics(reportProgress: () => void): Promise<void> {
        throw new Error("Diagnostics not supported.");
    }

    async cleanup() { }
}

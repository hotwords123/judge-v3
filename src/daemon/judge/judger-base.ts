import { TestData, SubtaskScoringType, TestcaseJudge } from '../interfaces';
import { CompilationResult, JudgeResult, TaskStatus, SubtaskResult, TestcaseDetails, TestcaseResultType } from '../../interfaces';
import { Language } from '../../languages';
import { compile } from './compile';
import winston = require('winston');
import _ = require('lodash');

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

    constructor(t: TestData, p: number) {
        this.priority = p;
        this.testData = t;
    }

    async preprocessTestData(): Promise<void> { }

    abstract compile(): Promise<CompilationResult>;
    compileWithDiagnostics(): Promise<CompilationResult> {
        throw new Error("Diagnostics not supported.");
    }

    async judge(reportProgressResult: (p: JudgeResult) => Promise<void>): Promise<JudgeResult> {
        const results: SubtaskResult[] = this.testData.subtasks.map(t => ({
            cases: t.cases.map(j => ({
                status: TaskStatus.Waiting,
                result: { scoringRate: t.type !== SubtaskScoringType.Summation ? 1 : 0 } as any
            })),
            status: TaskStatus.Waiting
        }));

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

        const judgeTasks: Promise<void>[] = [];
        for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; subtaskIndex++) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];

            const updateCurrentSubtaskScore = () => updateSubtaskScore(currentTask, currentResult);

            judgeTasks.push((async () => {
                // Type minimum is skippable, run one by one
                if (currentTask.type !== SubtaskScoringType.Summation) {
                    let skipped: boolean = false;
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
                winston.verbose(`Subtask ${subtaskIndex}, finished`);
            })());
        }
        await Promise.all(judgeTasks);

        // Let's check whether this submission supports diagnostics first.
        if (this.supportDiagnostics()) {
            winston.verbose('Diagnostics supported.');
            let diagnosticCase: TestcaseJudge = null;
            let diagnosticDetails: TestcaseDetails = null;
            loop:
            // Find if there are suitable cases to run the diagnostics.
            for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; ++subtaskIndex) {
                const currentTask = this.testData.subtasks[subtaskIndex];
                const currentResult = results[subtaskIndex];
                for (let index = 0; index < currentTask.cases.length; ++index) {
                    const currentCase = currentTask.cases[index];
                    const currentTaskResult = currentResult.cases[index];
                    const currentTaskDetails = currentTaskResult.result;
                    // To trigger the diagnostics process:
                    // - the result type should be Wrong Answer or Runtime Error;
                    // - the time usage should not exceed 100 ms;
                    // - the memory usage should not exceed 16 MiB.
                    if (currentTaskDetails
                        && [TestcaseResultType.WrongAnswer, TestcaseResultType.RuntimeError].includes(currentTaskDetails.type)
                        && currentTaskDetails.time <= 100
                        && currentTaskDetails.memory <= 16 * 1024) {
                        diagnosticCase = currentCase;
                        diagnosticDetails = currentTaskDetails;
                        winston.verbose(`Testcase for diagnostics found: ${subtaskIndex} ${index}`);
                        break loop;
                    }
                }
            }
            if (diagnosticCase) {
                // Now let's start the diagnostics process.
                winston.verbose("Diagnostics started.");
                try {
                    await this.compileWithDiagnostics();
                    const diagnosticsResult = await this.judgeTestcase(diagnosticCase, async () => {
                        winston.verbose("Diagnostics started judging.");
                    });
                    winston.verbose("Diagnostics ended judging: ", diagnosticsResult);
                    if (diagnosticsResult.userError) {
                        winston.verbose("Diagnostics detected stderr.");
                        diagnosticDetails.diagnostics = diagnosticsResult.userError;
                        await reportProgress();
                    } else {
                        winston.verbose("Diagnostics didn't found any issue.");
                    }
                } catch (err) {
                    // Whether it succeeds does not affect the final result,
                    // so we just ignore the errors silently.
                    winston.warn('Diagnostics failed: ', err);
                }
            } else {
                winston.verbose('Testcase for diagnostics not found.');
            }
        }

        return { subtasks: results };
    }
    protected abstract judgeTestcase(curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails>;

    supportDiagnostics(): boolean {
        return false;
    }

    async cleanup() { }
}

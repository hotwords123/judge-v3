import { TestData, StandardJudgeParameter, TestcaseJudge } from '../interfaces';
import { TaskStatus, ErrorType, TestcaseDetails, CompilationResult, JudgeResult, TestcaseResult, StandardRunTask, StandardRunResult, RPCTaskType, TestcaseResultType } from '../../interfaces';
import { globalConfig as Cfg } from '../config';
import { cloneObject, readFileLength } from '../../utils';
import { compile } from './compile';
import { Language, getLanguage, DIAGNOSTICS_NAME_SUFFIX } from '../../languages';
import { runTask } from '../rmq';
import { JudgerBase } from './judger-base';

import pathLib = require('path');
import winston = require('winston');

export class StandardJudger extends JudgerBase {
    parameters: StandardJudgeParameter;
    userCodeLanguage: Language;
    spjExecutableName: string = null;
    userCodeExecuableName: string = null;

    constructor(testData: TestData,
        param: StandardJudgeParameter,
        priority: number) {
        super(testData, priority);
        this.parameters = param;
        this.userCodeLanguage = getLanguage(param.language);
    }

    async preprocessTestData(): Promise<void> {
        if (this.testData.spj != null) {
            winston.verbose("Compiling special judge.");
            const [spjExecutableName, spjResult] = await compile(this.testData.spj.sourceCode,
                this.testData.spj.language, null, this.priority);
            if (spjResult.status !== TaskStatus.Done) {
                winston.verbose("Special judge CE: " + spjResult.message);
                let message = null;
                if (spjResult.message != null && spjResult.message !== "") {
                    message = "===== Special Judge Compilation Message =====" + spjResult.message;
                }
                throw new Error(message);
            } else {
                this.spjExecutableName = spjExecutableName;
            }
        } else {
            this.spjExecutableName = null;
        }
    }

    async compile(): Promise<CompilationResult> {
        const language = getLanguage(this.parameters.language);
        const [executableName, compilationResult] = await compile(
            this.parameters.code,
            language,
            this.testData.extraSourceFiles[language.name],
            this.priority
        );
        this.userCodeExecuableName = executableName;
        return compilationResult;
    }

    async compileWithDiagnostics(): Promise<CompilationResult> {
        const language = getLanguage(this.parameters.language + DIAGNOSTICS_NAME_SUFFIX);
        const [executableName, compilationResult] = await compile(
            this.parameters.code,
            language,
            this.testData.extraSourceFiles[language.name],
            this.priority
        );
        this.userCodeExecuableName = executableName;
        return compilationResult;
    }

    supportDiagnostics(): boolean {
        return !!getLanguage(this.parameters.language + DIAGNOSTICS_NAME_SUFFIX);
    }

    async runDiagnostics(reportProgress: () => void): Promise<void> {
        const results = this.subtaskResults;

        let diagnosticCase: TestcaseJudge = null;
        let diagnosticDetails: TestcaseDetails = null;

        // The max time and memory usage required to run the diagnostics.
        // Note that the unit of memory usage in parameters is MiB,
        // however it is KiB when it comes to judge result.
        const maxTimeUsage = Math.min(
            Cfg.diagnostics.maxTimeRatio * this.parameters.timeLimit,
            Cfg.diagnostics.maxTime
        );
        const maxMemoryUsage = Math.min(
            Cfg.diagnostics.maxMemoryRatio * this.parameters.memoryLimit * 1024,
            Cfg.diagnostics.maxMemory
        );

        winston.verbose(`Diagnostics limits: time = ${maxTimeUsage}, memory = ${maxMemoryUsage}`);

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
                // - the time usage should not exceed maxTimeUsage;
                // - the memory usage should not exceed maxMemoryUsage.
                if (currentTaskDetails
                    && [TestcaseResultType.WrongAnswer, TestcaseResultType.RuntimeError].includes(currentTaskDetails.type)
                    && currentTaskDetails.time <= maxTimeUsage
                    && currentTaskDetails.memory <= maxMemoryUsage) {
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
                // First compile the source code with diagnostics options.
                await this.compileWithDiagnostics();
                const diagnosticsResult = await this.judgeTestcase(diagnosticCase, async () => {
                    winston.verbose("Diagnostics started judging.");
                });
                winston.verbose("Diagnostics ended judging: ", diagnosticsResult);
                // The diagnostics message is supposed to be written to stderr.
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

    async judgeTestcase(curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails> {
        const task: StandardRunTask = {
            testDataName: this.testData.name,
            inputData: curCase.input,
            answerData: curCase.output,
            time: this.parameters.timeLimit,
            memory: this.parameters.memoryLimit,
            fileIOInput: this.parameters.fileIOInput,
            fileIOOutput: this.parameters.fileIOOutput,
            userExecutableName: this.userCodeExecuableName,
            spjExecutableName: this.spjExecutableName
        };

        const [inputContent, outputContent, runResult]: [string, string, StandardRunResult] = await Promise.all([
            readFileLength(curCase.input ? pathLib.join(Cfg.testDataDirectory, this.testData.name, curCase.input) : null, Cfg.dataDisplayLimit),
            readFileLength(curCase.output ? pathLib.join(Cfg.testDataDirectory, this.testData.name, curCase.output) : null, Cfg.dataDisplayLimit),
            runTask({ type: RPCTaskType.RunStandard, task: task }, this.priority, started)
        ]) as any;

        return {
            type: runResult.result,
            time: runResult.time,
            memory: runResult.memory,
            userError: runResult.userError,
            userOutput: runResult.userOutput,
            scoringRate: runResult.scoringRate,
            spjMessage: runResult.spjMessage,
            input: { name: curCase.input, content: inputContent },
            output: { name: curCase.output, content: outputContent },
            systemMessage: runResult.systemMessage
        };
    }
}
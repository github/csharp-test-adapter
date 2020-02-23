import * as vscode from 'vscode';
import { TestAdapter, TestHub, testExplorerExtensionId, TestLoadStartedEvent, TestLoadFinishedEvent, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import * as fs from 'fs';
import * as path from 'path';
import { V2 } from './omnisharp/protocol';
import TestManager from './omnisharp/dotnetTest';
import CSharpExtensionExports from './omnisharp/CSharpExtensionExports'
import { EventStream } from './omnisharp/EventStream';
import { BaseEvent, ReportDotNetTestResults, WorkspaceInformationUpdated, DotNetTestRunStart } from './omnisharp/loggingEvents';
import { EventType } from './omnisharp/EventType';
import { Project, ProjectInfo, ClassInfo, TestMethodInfo } from './models';

export class OmnisharpAdapter implements TestAdapter {

    private disposables: { dispose(): void }[] = [];
    private setupDisposables: { dispose(): void }[] = [];

    private static instance: OmnisharpAdapter;

    private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
    private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
    private readonly autorunEmitter = new vscode.EventEmitter<void>();

    private projects = new Map<string, Project>();
    private readonly suite = <TestSuiteInfo> {
        type: 'suite',
        id: "",
        label: "",
        children: []
    };
    private readonly projectMap = new Map<string, ProjectInfo>();
    private readonly classMap = new Map<string, ClassInfo>();
    private readonly methodMap = new Map<string, TestMethodInfo>();
    private readonly fullNameToMethodMap = new Map<string, TestMethodInfo>();

    get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
    get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
    get autorun(): vscode.Event<void> | undefined { return this.autorunEmitter.event; }

    static async register(context: vscode.ExtensionContext) {

        const csharpExtension = vscode.extensions.getExtension<CSharpExtensionExports>("ms-vscode.csharp");
        if (!csharpExtension) {
            throw "C# extension not found";
        }

        const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
        if (!testExplorerExtension) {
            throw "Test Explorer extension not found";
        }

        // If an adapter has already been created, this is getting called because of a workspace change. Update the old one.
        if (OmnisharpAdapter.instance != null) {
            OmnisharpAdapter.instance._setup(csharpExtension.exports.eventStream, csharpExtension.exports.getTestManager());
            OmnisharpAdapter.instance._refresh();
            return;
        }

        const workspaceRootFolder = (vscode.workspace.workspaceFolders || [])[0];

        if (testExplorerExtension) {
            const testHub = testExplorerExtension.exports;
            
            const log = new Log('omnisharpTestAdapter', workspaceRootFolder, 'Omnisharp Test Adapter');
            context.subscriptions.push(log);
            
            OmnisharpAdapter.instance = new OmnisharpAdapter(log, csharpExtension.exports.getTestManager());
            OmnisharpAdapter.instance._setup(csharpExtension.exports.eventStream, csharpExtension.exports.getTestManager());
            testHub.registerTestAdapter(OmnisharpAdapter.instance);
        }
    }

    // Omnisharp requires a specific file for most of its functions, in order to find the project. It doesn't actually matter if we're referring to tests inside
    // that particular file.
    constructor(
        private readonly log: Log,
        private testManager: Promise<TestManager>
    ) {
        this.log.info('Initializing C# Test adapter');

        this.disposables.push(this.testsEmitter);
        this.disposables.push(this.testStatesEmitter);
        this.disposables.push(this.autorunEmitter);
    }

    private async _setup(eventStream: EventStream, testManager: Promise<TestManager>) {
        for (const disposable of this.setupDisposables) {
            disposable.dispose();
        }
        this.setupDisposables = [];

        this.testManager = testManager;
        let subscription = eventStream.subscribe(event => this._handleEvent(event));
        this.setupDisposables.push({ dispose() { subscription.unsubscribe(); } });
        this.setupDisposables.push(vscode.tasks.onDidEndTask(taskEvent => {
            if (taskEvent.execution.task.group === vscode.TaskGroup.Build || taskEvent.execution.task.group === vscode.TaskGroup.Rebuild) {
                this._refresh();
            }
        }));
    }

    private async _refresh()
    {
        try {
            this.log.info("Refreshing workspace...");
            for (let [, project] of this.projects) {
                // Check if project has changed
                let projectChanged = false;
                for (let [outputFile, lastModified] of project.OutputFiles) {
                    let newModified = fs.statSync(outputFile).mtime;
                    if (lastModified.getTime() !== newModified.getTime()) {
                        project.OutputFiles.set(outputFile, newModified);
                        projectChanged = true;
                    }
                }

                if (!projectChanged) {
                    this.log.info(`No change detected for project ${project.Name}. Skipping...`);
                    continue;
                }

                this.log.info(`Project ${project.Name} has changed. Rediscovering tests...`);
                let tests = await (await this.testManager).discoverTests(project.SourceFile, "mstest", false);
                this.log.info(`Project ${project.Name}: Discovered tests ${JSON.stringify(tests.map(o => o.FullyQualifiedName))}.`);
                this._loadTestSuite(project, tests);
                this.suite.children = Array.from<ProjectInfo>(this.projectMap.values());

                this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: this.suite });
            }
        }
        catch (error) {
            this.log.error(`Unexpected exception: ${error}`);
        }
    }

    async load(): Promise<void> {
        this._refresh();
    }

    async run(tests: string[]): Promise<void> {
        try {
            this.log.info(`Running tests ${JSON.stringify(tests)}`);

            this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests });

            let builtAssemblies = new Set<string>();
            const testInfos = this._findTests(tests);
            for (const test of testInfos) {
                let alreadyBuilt = builtAssemblies.has(test.assembly);
                await (await this.testManager).runDotnetTest(test.fullName, test.file, 'mstest', alreadyBuilt);
                if (!alreadyBuilt) {
                    builtAssemblies.add(test.assembly);
                }
            }

            this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
        }
        catch (error) {
            this.log.error(`Unexpected exception: ${error}`);
        }
    }

    async debug(tests: string[]): Promise<void> {
        try {
            this.log.info(`Running and debugging tests ${JSON.stringify(tests)}`);

            this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests });

            let builtAssemblies = new Set<string>();
            const testInfos = this._findTests(tests);
            for (const test of testInfos) {
                let alreadyBuilt = builtAssemblies.has(test.assembly);
                await (await this.testManager).debugDotnetTest(test.fullName, test.file, 'mstest', alreadyBuilt);
                if (!alreadyBuilt) {
                    builtAssemblies.add(test.assembly);
                }
            }

            this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
        }
        catch (error) {
            this.log.error(`Unexpected exception: ${error}`);
        }
    }


    cancel(): void {
        // in a "real" TestAdapter this would kill the child process for the current test run (if there is any)
        throw new Error("Method not implemented.");
    }

    dispose(): void {
        this.cancel();
        for (const disposable of this.disposables.concat(this.setupDisposables)) {
            disposable.dispose();
        }
        this.setupDisposables = [];
        this.disposables = [];
    }

    private _findTests(testIds: string[]) : TestMethodInfo[] {

        let testMethods = <TestMethodInfo[]> [];

        if (testIds.length === 1 && testIds[0] === "") {
            testMethods.push(...this.methodMap.values());
            return testMethods;
        }
        
        for (const testId of testIds) {
            let count = 0;
            for (let i = 0; i < testId.length; i++) {
                count+=+(':'===testId[i]);
            }
            switch (count)
            {
                case 0: {
                    let projectInfo = this.projectMap.get(testId);
                    if (projectInfo) {
                        for (const classInfo of projectInfo.children) {
                            testMethods.push(...classInfo.children);
                        }
                    }
                    break;
                }

                case 1: {
                    let classInfo = this.classMap.get(testId);
                    if (classInfo) {
                        testMethods.push(...classInfo.children);
                    }
                    break;
                }
                
                case 2: {
                    let methodInfo = this.methodMap.get(testId);
                    if (methodInfo) {
                        testMethods.push(methodInfo);
                    }
                    break;
                }
            }
        }
        return testMethods;
    }

    private _loadTestSuite(project: Project, tests: V2.TestInfo[]) {

        if (!tests || tests.length == 0) {
            return;
        }

        let projectInfo = <ProjectInfo> {
            type: 'suite',
            id: project.Name,
            label: project.Name,
            file: project.Path,
            line: 0
        };

        let testFiles: { [key: string]: V2.TestInfo[]; } = {};
        testFiles = tests.reduce<any>((rv : any, x: V2.TestInfo) => {
            (rv[x.CodeFilePath] = rv[x.CodeFilePath] || []).push(x);
            return rv;
        }, {});
        
        projectInfo.children = Object.values(testFiles).map(testGroup => {
            let className = path.basename(testGroup[0].CodeFilePath, '.cs');
            let testClassSuite = <ClassInfo> {
                type: 'suite',
                id: `${projectInfo.id}:${className}`,
                label: className,
                tooltip: testGroup[0].CodeFilePath,
                file: testGroup[0].CodeFilePath,
                line: 0
            };

            testClassSuite.children = testGroup.map(o => {
                const methodInfo =  <TestMethodInfo>{
                    type: 'test',
                    id: `${testClassSuite.id}:${o.FullyQualifiedName}`,
                    label: o.DisplayName,
                    file: o.CodeFilePath,
                    line: o.LineNumber - 2,
                    fullName: o.FullyQualifiedName,
                    assembly: project.Name
                };
                this.fullNameToMethodMap.set(methodInfo.fullName, methodInfo);
                this.methodMap.set(methodInfo.id, methodInfo);
                return methodInfo;
            });

            this.classMap.set(testClassSuite.id, testClassSuite); 
            return testClassSuite;
        });

        this.projectMap.set(projectInfo.id, projectInfo);

        return projectInfo;
    }

    private _handleEvent(event: BaseEvent): void {
        try {
            switch (event.type) {
                case EventType.WorkspaceInformationUpdated:
                    this._handleWorkspaceInformationUpdated(<WorkspaceInformationUpdated>event);
                    break;

                case EventType.DotNetTestRunStart:
                    this._handleDotNetTestRunStart((<DotNetTestRunStart>event).testMethod);
                    break;

                case EventType.ReportDotNetTestResults:
                    this._handleReportDotnetTestResults((<ReportDotNetTestResults>event).results);
                    break;
            }
        }
        catch (error) {
            this.log.error(`Unexpected exception: ${error}`);
        }
    }

    private _handleWorkspaceInformationUpdated(event: WorkspaceInformationUpdated) {
        let newProjects = new Map<string, Project>();
        if (event.info.DotNet && event.info.DotNet.Projects) {
            for (const project of event.info.DotNet.Projects) {
                if (project.SourceFiles && project.SourceFiles.length > 0) {
                    let newProject = new Project();
                    newProject.Name = project.Name;
                    newProject.Path = project.Path;
                    newProject.SourceFile = project.SourceFiles[0];
                    newProject.OutputFiles = new Map<string, Date>(project.Configurations.map<[string, Date]>(o => [o.CompilationOutputAssemblyFile, new Date()]));
                    newProjects.set(newProject.Path, newProject);
                }
            }
        }
        if (event.info.MsBuild && event.info.MsBuild.Projects) {
            for (const project of event.info.MsBuild.Projects) {
                if (project.SourceFiles && project.SourceFiles.length > 0) {
                    let newProject = new Project();
                    newProject.Name = project.AssemblyName;
                    newProject.Path = project.Path;
                    newProject.SourceFile = project.SourceFiles[0];
                    newProject.OutputFiles = new Map<string, Date>([[project.TargetPath, new Date()]]);
                    newProjects.set(newProject.Path, newProject);
                }
            }
        }

        this.projects = newProjects;
        this._refresh();
    }

    private _handleDotNetTestRunStart(testMethod: string) {
        let methodInfo = this.fullNameToMethodMap.get(testMethod);
        if (!methodInfo) {
            this.log.error(`Test run start observed for method ${testMethod}, but method info was not found.`);
            return;
        }

        let testStartedEvent = <TestRunStartedEvent> {
            type: 'started',
            tests: [ methodInfo.id ]
        };
        this.testStatesEmitter.fire(testStartedEvent);
    }
    
    private _handleReportDotnetTestResults(results: V2.DotNetTestResult[]) {

        results.forEach(result => {

            let methodInfo = this.fullNameToMethodMap.get(result.MethodName);
            if (!methodInfo) {
                this.log.error(`Result ${result.Outcome} reported for method ${result.MethodName} but no test was found.`);
                return;
            }

            let testEvent = <TestEvent> {
                type: 'test',
                test: methodInfo.id,
                state: result.Outcome
            };

            if (result.Outcome === V2.TestOutcomes.Failed) {
                this.log.info(`Test ${result.MethodName} failed with error ${result.ErrorMessage}.`);
                let errorHeader = [ `${result.ErrorMessage}`, `${result.ErrorStackTrace}` ];
                testEvent.message = errorHeader.concat(result.StandardOutput, result.StandardError).join('\n');
            }
            else {
                this.log.info(`Test ${result.MethodName} passed.`);
                testEvent.message = result.StandardOutput.concat(result.StandardError).join('\n');
            }

            this.testStatesEmitter.fire(testEvent);
        });
    }
}

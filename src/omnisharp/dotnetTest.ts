import * as protocol from './protocol';

export default interface TestManager {

    discoverTests(fileName: string, testFrameworkName: string, noBuild: boolean): Promise<protocol.V2.TestInfo[]>;

    runDotnetTest(testMethod: string, fileName: string, testFrameworkName: string, noBuild: boolean) : void;

    runDotnetTestsInClass(className: string, methodsInClass: string[], fileName: string, testFrameworkName: string, noBuild: boolean) : void;

    debugDotnetTest(testMethod: string, fileName: string, testFrameworkName: string, noBuild: boolean) : void;

    debugDotnetTestsInClass(className: string, methodsToRun: string[], fileName: string, testFrameworkName: string, noBuild: boolean) : void;
}

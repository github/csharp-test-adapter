import { TestSuiteInfo, TestInfo } from "vscode-test-adapter-api";

export class Project {
    public Name!: string;
    public Path!: string;
    public SourceFile!: string;
    public OutputFiles!: Map<string, Date>;
}

export class ProjectInfo implements TestSuiteInfo {
    type: "suite" = "suite";   
    id!: string;
    label!: string;
    description?: string;
    tooltip?: string;
    file!: string;
    line: number = 0;
    children: ClassInfo[] = [];
}

export class ClassInfo implements TestSuiteInfo {
    type: "suite" = "suite";    
    id!: string;
    label!: string;
    description?: string;
    tooltip?: string;
    file!: string;
    line: number = 0;
    children: TestMethodInfo[] = [];
}

export class TestMethodInfo implements TestInfo {
    type: "test" = "test"; 
    id!: string;
    label!: string;
    description?: string;
    tooltip?: string;
    file!: string;
    line!: number;
    skipped?: boolean;
    fullName!: string;
    assembly!: string;
}
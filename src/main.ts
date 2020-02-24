import * as vscode from 'vscode';
import { CSharpAdapter } from './adapter';

export async function activate(context: vscode.ExtensionContext) {

    CSharpAdapter.register(context);
}

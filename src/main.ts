import * as vscode from 'vscode';
import { OmnisharpAdapter } from './adapter';

export async function activate(context: vscode.ExtensionContext) {

    OmnisharpAdapter.register(context);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventStream } from "./EventStream";
import TestManager from "./dotnetTest";

export default interface CSharpExtensionExports {
    initializationFinished: () => Promise<void>;
    getTestManager: () => Promise<TestManager>;
    eventStream: EventStream;
}
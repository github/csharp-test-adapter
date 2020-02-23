/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Subscription } from "rxjs";
import { BaseEvent } from "./loggingEvents";

export interface EventStream {
    post(event: BaseEvent) : void;
    subscribe(eventHandler: (event: BaseEvent) => void): Subscription;
}
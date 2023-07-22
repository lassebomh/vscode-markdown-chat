"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require("vscode");
const yaml = require("js-yaml");
const openai_1 = require("openai");
const defaultOptions = {
    "model": "gpt-4",
    "temperature": 0.7,
    "max_tokens": 100,
};
const defaultFileContents = `\
---
${yaml.dump(defaultOptions)}---

[system]

You are a helpful assistant

[user]

`;
function activate(context) {
    let setApiKey = vscode.commands.registerCommand('markdown-chat.setApiKey', () => {
        vscode.window.showInputBox({ prompt: 'Enter API Key' }).then(value => {
            if (value !== undefined) {
                let config = vscode.workspace.getConfiguration('markdown-chat');
                config.update('apiKey', value, vscode.ConfigurationTarget.Global);
            }
        });
    });
    let completeMarkdownChat = vscode.commands.registerCommand('markdown-chat.send-markdown-chat', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const document = editor.document;
        let text = document.getText();
        let documentOptionsSplit = text.split(/^-{3}$/gm);
        let options = defaultOptions;
        let messagesText = text;
        if (documentOptionsSplit.length > 2 && documentOptionsSplit[0] === '') {
            options = { ...options, ...yaml.load(documentOptionsSplit[1]) };
            messagesText = documentOptionsSplit[2];
        }
        let messagesSplit = messagesText.split(/^\[([^\]]+)\] *$/gm);
        messagesSplit.shift();
        let messages = [];
        for (let i = 0; i < messagesSplit.length; i += 2) {
            messages.push({
                role: messagesSplit[i],
                content: messagesSplit[i + 1]
            });
        }
        let config = vscode.workspace.getConfiguration('markdown-chat');
        const openai = new openai_1.default({
            apiKey: config.get('apiKey')
        });
        const stream = await openai.chat.completions.create({
            ...options,
            messages: messages,
            stream: true,
        });
        const endNewlinesMatch = text.match(/\n*$/);
        const endNewlinesCountDiff = 2 - (endNewlinesMatch ? endNewlinesMatch[0].length : 0);
        let chunks = [];
        let lastAppend = null;
        function appendChunk(chunk, force = false, insertUndo = false) {
            return new Promise((resolve) => {
                chunks.push(chunk);
                if (!force && lastAppend !== null && (new Date().getTime() - lastAppend.getTime()) < 50) {
                    resolve();
                    return;
                }
                let insert = "".concat(...chunks);
                chunks = [];
                lastAppend = new Date();
                editor.edit(editBuilder => {
                    const lastLine = document.lineAt(document.lineCount - 1);
                    const position = new vscode.Position(lastLine.lineNumber, lastLine.text.length);
                    editBuilder.insert(position, insert);
                    resolve();
                }, {
                    undoStopAfter: insertUndo,
                    undoStopBefore: insertUndo,
                });
            });
        }
        await appendChunk('', false, true);
        if (endNewlinesCountDiff > 0) {
            await appendChunk('\n'.repeat(endNewlinesCountDiff));
        }
        await appendChunk('[assistant]\n\n');
        let finish_reason = null;
        let resolveResponse;
        let responsePromise = new Promise((resolve) => {
            resolveResponse = resolve;
        });
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Getting answer from OpenAI...",
            cancellable: true
        }, (progress, token) => {
            token.onCancellationRequested(() => {
                finish_reason = 'cancelled';
            });
            return responsePromise;
        });
        for await (const part of stream) {
            if (finish_reason !== null) {
                break;
            }
            await appendChunk(part.choices[0]?.delta?.content || '');
            finish_reason = part.choices[0]?.finish_reason;
        }
        if (finish_reason !== 'stop') {
            vscode.window.showInformationMessage('Stopped. Reason: ' + finish_reason);
        }
        else {
            await appendChunk('\n\n[user]\n\n', true);
        }
        resolveResponse();
    });
    let newMarkdownChat = vscode.commands.registerCommand('markdown-chat.new-markdown-chat', async () => {
        const document = await vscode.workspace.openTextDocument({ content: defaultFileContents, language: 'markdown' });
        const editor = await vscode.window.showTextDocument(document);
        const position = editor.document.lineAt(document.lineCount - 1).range.end;
        const newSelection = new vscode.Selection(position, position);
        editor.selection = newSelection;
    });
    context.subscriptions.push(setApiKey, completeMarkdownChat, newMarkdownChat);
}
exports.activate = activate;
// This method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
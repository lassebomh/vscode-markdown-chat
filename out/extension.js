"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
/* eslint-disable @typescript-eslint/naming-convention */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(require("vscode"));
const yaml = __importStar(require("js-yaml"));
const openai_1 = __importDefault(require("openai"));
const lite_1 = require("tiktoken/lite");
const cl100k_base_json_1 = __importDefault(require("tiktoken/encoders/cl100k_base.json"));
const regexSplitMessages = /(^|\n)\n?\[([a-z]+)\] *\n{0,2}/g;
const DEFAULT_PROMPT_TEMPLATE = {
    "mode": "chat",
    "model": "gpt-4",
    "temperature": 0.75,
    "max_tokens": 500,
    "messages": [
        {
            "role": "system",
            "content": "You are a helpful assistant. Answer in markdown."
        },
        {
            "role": "user",
            "content": ""
        }
    ]
};
let completionInProgress = false;
let totalSessionCost = 0;
function serializePromptTemplate(text) {
    let options = {};
    const metadataSplit = text.split(/^---\n/m);
    let rawPrompt = text;
    if (metadataSplit[0] === "" && metadataSplit.length >= 3) {
        options = yaml.load(metadataSplit[1]);
        rawPrompt = metadataSplit.slice(2).join("---");
    }
    const mode = options["mode"] || "chat";
    if (mode === "chat") {
        const messagesSplit = rawPrompt.split(regexSplitMessages);
        options["messages"] = [];
        for (let i = 1; i < messagesSplit.length; i += 3) {
            options["messages"].push({ "role": messagesSplit[i + 1], "content": messagesSplit[i + 2] });
        }
    }
    else if (mode === "complete") {
        options["prompt"] = rawPrompt;
    }
    return options;
}
function unserializePromptTemplate(options) {
    options = { ...options };
    const mode = options["mode"] || "chat";
    let rawPrompt = '';
    if (mode == 'chat') {
        let messages = options['messages'];
        rawPrompt += "\n";
        for (const message of messages) {
            rawPrompt += `[${message.role}]\n\n${message.content}`;
            if (message.content) {
                if (message != messages[messages.length - 1]) {
                    rawPrompt += "\n\n";
                }
            }
        }
    }
    else if (mode == 'complete') {
        rawPrompt = options['prompt'];
    }
    delete options['messages'];
    delete options['prompt'];
    return '---\n' + yaml.dump(options) + '---\n' + rawPrompt;
}
function getContextModel(usageStore, tokens, model) {
    for (let i = 0; i < usageStore[model].length; i++) {
        if (tokens <= usageStore[model][i].contextSize) {
            return i;
        }
    }
}
function countPromptTemplateInputTokens(encoding, options) {
    let num_tokens = 0;
    if (options['mode'] == 'chat') {
        for (const message in options['messages']) {
            num_tokens += encoding.encode(message.content).length;
        }
        return num_tokens;
    }
    else {
        num_tokens += encoding.encode(options['prompt']).length;
        return num_tokens;
    }
}
function activate(context) {
    let setApiKey = vscode.commands.registerCommand('markdown-chat.setApiKey', () => {
        vscode.window.showInputBox({ prompt: 'Enter your OpenAI API Key' }).then(value => {
            if (value !== undefined) {
                let config = vscode.workspace.getConfiguration('markdown-chat');
                config.update('apiKey', value, vscode.ConfigurationTarget.Global);
            }
        });
    });
    let completeMarkdownChat = vscode.commands.registerCommand('markdown-chat.sendMarkdownChat', async () => {
        let logerr;
        let resolveFetchResponse;
        let rejectFetchResponse;
        let config = vscode.workspace.getConfiguration('markdown-chat');
        if (completionInProgress) {
            throw new Error("A completion is already in progress.");
        }
        let encoding = new lite_1.Tiktoken(cl100k_base_json_1.default.bpe_ranks, cl100k_base_json_1.default.special_tokens, cl100k_base_json_1.default.pat_str);
        let options = {
            stream: true,
        };
        let inputTokenCount = 0;
        let outputTokenCount = 0;
        try {
            completionInProgress = true;
            let editor = vscode.window.activeTextEditor;
            if (!editor) {
                throw new Error('No editor found');
            }
            if (!editor.document) {
                throw new Error('No document open');
            }
            let completeFilename = editor.document.fileName;
            let text = editor.document.getText();
            let defaultPromptTemplate = config.get('defaultMarkdownChat') || DEFAULT_PROMPT_TEMPLATE;
            let currentPromptTemplate = serializePromptTemplate(text);
            if (defaultPromptTemplate['mode'] == currentPromptTemplate['mode']) {
                currentPromptTemplate = {
                    ...defaultPromptTemplate,
                    ...currentPromptTemplate
                };
            }
            options = {
                ...currentPromptTemplate,
                stream: true,
            };
            inputTokenCount += countPromptTemplateInputTokens(encoding, options);
            let mode = options['mode'];
            delete options['mode'];
            if (mode == 'chat' && options.messages.length === 0) {
                throw new Error("The chat doesn't contain any messages");
            }
            const openai = new openai_1.default({ apiKey: config.get('apiKey') });
            let stream;
            if (mode == 'chat') {
                stream = await openai.chat.completions.create(options);
                outputTokenCount += 3;
            }
            else {
                stream = await openai.completions.create(options);
            }
            let chunks = [];
            let lastChunkAppend = null;
            async function appendChunk(chunk, insertUndo = false) {
                chunks.push(chunk);
                editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return false;
                }
                let document = editor.document;
                if (document == null || document.fileName != completeFilename) {
                    return false;
                }
                const waited = lastChunkAppend == null || (new Date().getTime() - lastChunkAppend.getTime()) >= 0;
                if (!waited) {
                    return false;
                }
                let insert = "".concat(...chunks);
                let ok = await new Promise((resolve, reject) => {
                    editor.edit(editBuilder => {
                        const lastLine = document.lineAt(document.lineCount - 1);
                        const position = new vscode.Position(lastLine.lineNumber, lastLine.text.length);
                        editBuilder.insert(position, insert);
                    }, {
                        undoStopAfter: insertUndo,
                        undoStopBefore: insertUndo,
                    }).then(resolve, (e) => {
                        console.error(e);
                        resolve(false);
                    });
                });
                if (ok) {
                    chunks = [];
                    lastChunkAppend = new Date();
                }
                return ok;
            }
            await appendChunk('', true);
            if (mode == 'chat') {
                const endNewlinesMatch = text.match(/\n*$/);
                const endNewlinesCountDiff = 2 - (endNewlinesMatch ? endNewlinesMatch[0].length : 0);
                if (endNewlinesCountDiff > 0) {
                    await appendChunk('\n'.repeat(endNewlinesCountDiff));
                }
                await appendChunk('[assistant]\n\n');
            }
            let finish_reason = null;
            let responsePromise = new Promise((resolve, reject) => {
                resolveFetchResponse = resolve;
                rejectFetchResponse = reject;
            });
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Getting answer from OpenAI...",
                cancellable: true
            }, (progress, token) => {
                token.onCancellationRequested(() => {
                    finish_reason = 'user';
                });
                return responsePromise;
            });
            for await (const part of stream) {
                if (finish_reason !== null) {
                    break;
                }
                let insert;
                if (mode == 'chat') {
                    insert = part.choices[0]?.delta?.content || '';
                }
                else {
                    insert = part.choices[0].text || '';
                }
                await appendChunk(insert);
                if (insert != "") {
                    outputTokenCount += encoding.encode(insert).length;
                }
                finish_reason = part.choices[0]?.finish_reason;
            }
            let models = config.get('models');
            let model = options['model'];
            let ci = getContextModel(models, options.max_tokens, model);
            models[model][ci]['inputCount'] += inputTokenCount;
            models[model][ci]['outputCount'] += outputTokenCount;
            config.update('models', models, vscode.ConfigurationTarget.Global);
            if (finish_reason !== 'stop' && finish_reason !== 'user') {
                throw new Error('Stopped. Reason: ' + finish_reason);
            }
            else if (mode == 'chat') {
                await appendChunk('\n\n[user]\n\n', true);
            }
            resolveFetchResponse();
            // let waitPromise = new Promise((resolve, reject) => {
            //     resolveWaitInsert = resolve;
            //     rejectWaitInsert = reject
            // });
            if (chunks.length > 0) {
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Completion finished, but cannot insert result until the prompt file is opened.",
                    cancellable: true
                }, (progress, token) => {
                    return new Promise(async (resolve, reject) => {
                        // resolveWaitInsert = resolve;
                        // rejectWaitInsert = reject;
                        let loop = true;
                        token.onCancellationRequested(() => {
                            loop = false;
                            reject("Result has been deleted.");
                        });
                        while (loop) {
                            loop = !(await appendChunk('', false));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        resolve();
                    });
                });
            }
        }
        catch (error) {
            logerr = error;
        }
        finally {
            completionInProgress = false;
            encoding.free();
            if (rejectFetchResponse)
                rejectFetchResponse();
            if (logerr != null) {
                console.error(logerr);
                throw logerr;
            }
        }
    });
    let newMarkdownChat = vscode.commands.registerCommand('markdown-chat.newMarkdownChat', async () => {
        let config = vscode.workspace.getConfiguration('markdown-chat');
        let text = unserializePromptTemplate(config.get('defaultMarkdownChat') || DEFAULT_PROMPT_TEMPLATE);
        const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        const editor = await vscode.window.showTextDocument(document);
        const position = editor.document.lineAt(document.lineCount - 1).range.end;
        const newSelection = new vscode.Selection(position, position);
        editor.selection = newSelection;
    });
    let setMarkdownChatAsDefault = vscode.commands.registerCommand('markdown-chat.setMarkdownChatAsDefault', () => {
        let config = vscode.workspace.getConfiguration('markdown-chat');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No document is open.');
            return;
        }
        const document = editor.document;
        let text = document.getText();
        let markdownChat = serializePromptTemplate(text);
        if (!('model' in markdownChat)) {
            vscode.window.showErrorMessage('The default chat is missing "model" in its metadata.');
            return;
        }
        if (!('mode' in markdownChat)) {
            vscode.window.showErrorMessage('The default chat is missing "mode" in its metadata.');
            return;
        }
        if (!('max_tokens' in markdownChat)) {
            vscode.window.showErrorMessage('The default chat is missing "max_tokens" in its metadata.');
            return;
        }
        config.update('defaultMarkdownChat', markdownChat, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('The default chat has been set to the current document.');
    });
    context.subscriptions.push(setApiKey, completeMarkdownChat, newMarkdownChat, setMarkdownChatAsDefault);
}
exports.activate = activate;
// This method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
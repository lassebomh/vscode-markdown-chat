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
const nunjucks = __importStar(require("nunjucks"));
const lite_1 = require("tiktoken/lite");
const cl100k_base_json_1 = __importDefault(require("tiktoken/encoders/cl100k_base.json"));
let lastCostStatusBarItem;
const regexSplitMessages = /(^|\n)\n?\[([a-zA-Z0-9\:\_]+)\] *\n{0,2}/g;
const DEFAULT_PROMPT_TEMPLATE = {
    "mode": "chat",
    "options": {
        "model": "gpt-4",
        "temperature": 0.75,
        "max_tokens": 500,
        "messages": [
            {
                "role": "system",
                "content": "You are a helpful assistant. Answer in markdown."
            },
            {
                "role": "assistant",
                "content": null,
                "function_call": {
                    'name': 'get_weather',
                    'arguments': '{"region": "USA"}'
                }
            },
            {
                "role": "function",
                "name": "get_weather",
                "content": "The result of the function"
            }
        ]
    }
};
let completionInProgress = false;
let totalSessionCost = 0;
async function serializePromptTemplate(text, interactive = false) {
    let template = {};
    const metadataSplit = text.split(/^---\n/m);
    let rawPrompt = text;
    if (metadataSplit[0] === "" && metadataSplit.length >= 3) {
        template = yaml.load(metadataSplit[1]);
        rawPrompt = metadataSplit.slice(2).join("---");
    }
    if (template.nunjucks !== false && interactive) {
        let env = new nunjucks.Environment();
        if (typeof template.nunjucks === 'object') {
            env.options = template.nunjucks;
        }
        let context = { ...template };
        if (template.inputs != null) {
            for (let i = 0; i < template.inputs.length; i++) {
                const input = template.inputs[i];
                let value = input.value;
                let prompt = input.prompt;
                if (prompt) {
                    value = await new Promise((resolve, reject) => {
                        vscode.window
                            .showInputBox({
                            prompt: `Assign ${input.name} a value`,
                            ignoreFocusOut: true,
                            value: input.value || '',
                        })
                            .then(resolve, reject);
                    });
                }
                context[input.name] = value;
            }
        }
        rawPrompt = env.renderString(rawPrompt, context);
    }
    if (template.mode === "chat") {
        const messagesSplit = rawPrompt.split(regexSplitMessages);
        console.log(messagesSplit);
        template.options.messages = [];
        for (let i = 1; i < messagesSplit.length; i += 3) {
            let [role, name] = messagesSplit[i + 1].split(':');
            let content = messagesSplit[i + 2];
            let function_call;
            console.log(role, name, content);
            if (name == 'function_call') {
                function_call = JSON.parse(content.replace(/^\s*\`\`\`json/, '').replace(/\`\`\`\s*$/, ''));
                function_call.arguments = JSON.stringify(function_call.arguments);
                content = null;
                name = undefined;
            }
            template.options.messages.push({
                "role": role,
                "content": content,
                "name": name,
                "function_call": function_call,
            });
            console.log(template.options.messages[template.options.messages.length - 1]);
        }
    }
    else if (template.mode === "complete") {
        template.options.prompt = rawPrompt;
    }
    return template;
}
function unserializePromptTemplate(templ) {
    let template = { ...templ, 'options': { ...templ.options } };
    let rawPrompt = '';
    if (template.mode == 'chat') {
        let messages = template.options.messages;
        rawPrompt += "\n";
        for (const message of messages) {
            let role = message.role;
            let name = message.name;
            let content = message.content;
            if (message.function_call != null) {
                name = 'function_call';
                message.function_call.arguments = JSON.parse(message.function_call.arguments);
                content = '\`\`\`json\n' + JSON.stringify(message.function_call, null, 2) + '\n\`\`\`';
            }
            rawPrompt += `[${role}${name ? ':' : ''}${name || ''}]\n\n${content}`;
            if (content) {
                if (message != messages[messages.length - 1]) {
                    rawPrompt += "\n\n";
                }
            }
        }
    }
    else if (template.mode == 'complete') {
        rawPrompt = template.options.prompt;
    }
    delete template.options['messages'];
    delete template.options['prompt'];
    return '---\n' + yaml.dump(template) + '---\n' + rawPrompt;
}
function getContextModel(usageStore, tokens, model) {
    for (let i = 0; i < usageStore[model].length; i++) {
        if (tokens <= usageStore[model][i].contextSize) {
            return i;
        }
    }
}
function countPromptTemplateInputTokens(encoding, template) {
    let num_tokens = 0;
    if (template.mode == 'chat') {
        for (let i = 0; i < template['options']['messages'].length; i++) {
            const message = template['options']['messages'][i];
            let tokens = encoding.encode(message.content || (message.function_call.name ? JSON.stringify(message.function_call?.arguments) + message.function_call?.name : ''));
            num_tokens += tokens.length;
        }
        if (template.options['functions'] != null) {
            const functionsString = JSON.stringify(template.options['functions']);
            let tokens = encoding.encode(functionsString);
            num_tokens += tokens.length;
        }
        return num_tokens;
    }
    else {
        num_tokens += encoding.encode(template.options['prompt']).length;
        return num_tokens;
    }
}
function updateLastCostStatusBarItem(cost) {
    if (cost > 0) {
        lastCostStatusBarItem.text = `$(debug-restart) ${Math.round(1 / cost * 10) / 10}/$   $(graph-line) ${Math.round(totalSessionCost * 1000) / 10} cents`;
        lastCostStatusBarItem.show();
    }
    else {
        lastCostStatusBarItem.hide();
    }
}
function activate(context) {
    // create a new status bar item that we can now manage
    lastCostStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(lastCostStatusBarItem);
    // update status bar item once at start
    updateLastCostStatusBarItem(0);
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
            let template = await serializePromptTemplate(text, true);
            inputTokenCount += countPromptTemplateInputTokens(encoding, template);
            if (template.mode == 'chat' && template.options.messages.length === 0) {
                throw new Error("The chat doesn't contain any messages");
            }
            const openai = new openai_1.default({ apiKey: config.get('apiKey') });
            let stream;
            let requestOptions = {
                ...template.options,
                stream: true,
            };
            console.log(requestOptions);
            if (template.mode == 'chat') {
                stream = await openai.chat.completions.create(requestOptions);
                outputTokenCount += 3;
            }
            else {
                stream = await openai.completions.create(requestOptions);
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
            if (template.mode == 'chat') {
                const endNewlinesMatch = text.match(/\n*$/);
                const endNewlinesCountDiff = 2 - (endNewlinesMatch ? endNewlinesMatch[0].length : 0);
                if (endNewlinesCountDiff > 0) {
                    await appendChunk('\n'.repeat(endNewlinesCountDiff));
                }
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
            let callingFunction;
            for await (const part of stream) {
                if (finish_reason !== null) {
                    break;
                }
                let insert;
                if (template.mode == 'chat') {
                    let delta = part.choices[0].delta;
                    console.log(delta);
                    if (delta.role) {
                        let name = '';
                        if (delta.name != null) {
                            name = ":" + delta.name;
                        }
                        if (delta.function_call != null) {
                            name = ":function_call";
                            callingFunction = delta.function_call.name;
                        }
                        await appendChunk(`[${delta.role}${name}]\n\n`);
                        if (callingFunction) {
                            await appendChunk(`\`\`\`json\n{\n  "name": "${delta.function_call.name}",\n  "arguments": `);
                        }
                    }
                    insert = delta.function_call?.arguments || delta.content || '';
                    if (callingFunction) {
                        insert = insert.replace('\n', '\n  ');
                    }
                }
                else {
                    insert = part.choices[0].text || '';
                }
                if (insert != "") {
                    outputTokenCount += encoding.encode(insert).length;
                    await appendChunk(insert);
                }
                finish_reason = part.choices[0]?.finish_reason;
            }
            if (callingFunction) {
                await appendChunk('\n}\n```');
            }
            let models = { ...config.get('models') };
            let model = template.options['model'];
            let ci = getContextModel(models, template.options.max_tokens, model);
            models[model][ci]['inputCount'] += inputTokenCount;
            models[model][ci]['outputCount'] += outputTokenCount;
            let cost = inputTokenCount * models[model][ci]['inputPrice'] / 1000 + outputTokenCount * models[model][ci]['outputPrice'] / 1000;
            totalSessionCost += cost;
            updateLastCostStatusBarItem(cost);
            config.update('models', models, vscode.ConfigurationTarget.Global);
            if (finish_reason !== 'stop' && finish_reason !== 'user' && finish_reason !== 'function_call') {
                throw new Error('Stopped. Reason: ' + finish_reason);
            }
            else if (template.mode == 'chat') {
                let responder = 'user';
                if (callingFunction) {
                    responder = "function:" + callingFunction;
                }
                await appendChunk(`\n\n[${responder}]\n\n`, true);
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
    let setMarkdownChatAsDefault = vscode.commands.registerCommand('markdown-chat.setMarkdownChatAsDefault', async () => {
        let config = vscode.workspace.getConfiguration('markdown-chat');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No document is open.');
            return;
        }
        const document = editor.document;
        let text = document.getText();
        let template = await serializePromptTemplate(text);
        if (template.options['model'] == null) {
            vscode.window.showErrorMessage('The default chat is missing "options.model" in its metadata.');
            return;
        }
        if (template['mode'] == null) {
            vscode.window.showErrorMessage('The default chat is missing "mode" in its metadata.');
            return;
        }
        if (template.options['max_tokens'] == null) {
            vscode.window.showErrorMessage('The default chat is missing "options.max_tokens" in its metadata.');
            return;
        }
        config.update('defaultMarkdownChat', template, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('The default chat has been set to the current document.');
    });
    context.subscriptions.push(setApiKey, completeMarkdownChat, newMarkdownChat, setMarkdownChatAsDefault);
}
exports.activate = activate;
// This method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
/* eslint-disable @typescript-eslint/naming-convention */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import OpenAI from 'openai';

import { Tiktoken } from "tiktoken/lite";
import cl100k_base from "tiktoken/encoders/cl100k_base.json";


let lastCostStatusBarItem: vscode.StatusBarItem;

const regexSplitMessages = /(^|\n)\n?\[([a-z]+)\] *\n{0,2}/g

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
  }

type PromptTemplate = string;
type PromptOptions = {[index: string]: any};

let completionInProgress = false;

let totalSessionCost: number = 0

function serializePromptTemplate(text: PromptTemplate): PromptOptions {
    let options: PromptOptions = {};

    const metadataSplit = text.split(/^---\n/m);
    let rawPrompt = text;

    if (metadataSplit[0] === "" && metadataSplit.length >= 3) {
        options = <any>yaml.load(metadataSplit[1]);
        rawPrompt = metadataSplit.slice(2).join("---");
    }

    const mode = options["mode"] || "chat";

    if (mode === "chat") {
        const messagesSplit = rawPrompt.split(regexSplitMessages);

        options["messages"] = [];

        for (let i = 1; i < messagesSplit.length; i += 3) {
            options["messages"].push({"role": messagesSplit[i + 1], "content": messagesSplit[i + 2]});
        }
    } else if (mode === "complete") {
        options["prompt"] = rawPrompt;
    }

    return options;
}

function unserializePromptTemplate(options: any): string {
    options = {...options}
    
    const mode = options["mode"] || "chat";

    let rawPrompt = ''

    if (mode == 'chat') {
        let messages = options['messages'];

        rawPrompt += "\n"
        
        for (const message of messages) {
            rawPrompt += `[${message.role}]\n\n${message.content}`;
            if (message.content) {
                if (message != messages[messages.length - 1]) {
                    rawPrompt += "\n\n";
                }
            }
        }
    } else if (mode == 'complete') {

        rawPrompt = options['prompt']
    }

    delete options['messages'];
    delete options['prompt'];
    
    return '---\n' + yaml.dump(options) + '---\n' + rawPrompt;
}

function getContextModel(usageStore: any, tokens: number, model: string): any {
    for (let i = 0; i < usageStore[model].length; i++) {
        if (tokens <= (<any>usageStore[model][i]).contextSize) {
            return i;
        }
    }
}

function countPromptTemplateInputTokens(encoding: any, options: any): number {
    let num_tokens = 0

    if (options['mode'] == 'chat') {

        for (let i = 0; i < options['messages'].length; i++) {
            const message = options['messages'][i];
            let tokens = encoding.encode(message.content)
            num_tokens += tokens.length
        }

        return num_tokens
    } else {
        num_tokens += encoding.encode(options['prompt']).length
        return num_tokens
    }
}


function updateLastCostStatusBarItem(cost: number): void {
	if (cost > 0) {
		lastCostStatusBarItem.text = `$(debug-restart) ${Math.round(1/cost * 10) / 10}/$   $(graph-line) ${Math.round(totalSessionCost * 1000) / 10} cents`;
		lastCostStatusBarItem.show();
	} else {
		lastCostStatusBarItem.hide();
	}
}

export function activate(context: vscode.ExtensionContext) {

	// create a new status bar item that we can now manage
	lastCostStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	context.subscriptions.push(lastCostStatusBarItem);

	// update status bar item once at start
    updateLastCostStatusBarItem(0)

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
        
        let resolveFetchResponse: any;
        let rejectFetchResponse: any;

        let config = vscode.workspace.getConfiguration('markdown-chat');

        if (completionInProgress) {
            throw new Error("A completion is already in progress.")
        }

        let encoding = new Tiktoken(
            cl100k_base.bpe_ranks,
            cl100k_base.special_tokens,
            cl100k_base.pat_str
        );

        let options: {stream: true} & {[key: string]: any;} = {
            stream: true,
        };

        let inputTokenCount = 0
        let outputTokenCount = 0

        try {
            completionInProgress = true;

            let editor = vscode.window.activeTextEditor;

            if (!editor) {
                throw new Error('No editor found')
            }

            if (!editor.document) {
                throw new Error('No document open')
            }

            let completeFilename = editor.document.fileName

            let text = editor.document.getText();

            let defaultPromptTemplate = <any>config.get('defaultMarkdownChat') || DEFAULT_PROMPT_TEMPLATE

            let currentPromptTemplate = serializePromptTemplate(text)


            if (defaultPromptTemplate['mode'] == currentPromptTemplate['mode']) {
                currentPromptTemplate = {
                    ...defaultPromptTemplate,
                    ...currentPromptTemplate
                }
            }

            options = {
                ...currentPromptTemplate,
                stream: true,
            };

            inputTokenCount += countPromptTemplateInputTokens(encoding, options)

            let mode = options['mode'];
            delete options['mode'];

            if (mode == 'chat' && options.messages.length === 0) {
                throw new Error("The chat doesn't contain any messages");
            }

            const openai = new OpenAI({apiKey: config.get('apiKey')});

            let stream;

            if (mode == 'chat') {
                stream = await openai.chat.completions.create(<any>options)
                outputTokenCount += 3
            } else {
                stream = await openai.completions.create(<any>options)
            }

            let chunks: string[] = [];

            let lastChunkAppend: Date | null = null;

            async function appendChunk(chunk: string, insertUndo: boolean = false): Promise<boolean> {
                chunks.push(chunk);
                
                editor = vscode.window.activeTextEditor

                if (!editor) {
                    return false;
                }

                let document = editor.document

                if (document == null || document.fileName != completeFilename) {
                    return false;
                }

                const waited = lastChunkAppend == null || (new Date().getTime() - lastChunkAppend.getTime()) >= 0;

                if (!waited) {
                    return false;
                }

                let insert = "".concat(...chunks);

                let ok: boolean = await new Promise((resolve, reject) => {
                    editor!.edit(editBuilder => {
                        const lastLine = document!.lineAt(document!.lineCount - 1);
                        const position = new vscode.Position(lastLine.lineNumber, lastLine.text.length);

                        editBuilder.insert(position, insert);
                    }, {
                        undoStopAfter: insertUndo,
                        undoStopBefore: insertUndo,
                    }).then(resolve, (e) => {
                        console.error(e)
                        resolve(false)
                    });
                })

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

            let finish_reason: string | null = null;

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
            
            for await (const part of <any>stream) {
                if (finish_reason !== null) {
                    break;
                }

                let insert: string 

                if (mode == 'chat') {
                    insert = part.choices[0]?.delta?.content || ''
                } else {
                    insert = part.choices[0].text || ''
                }
                await appendChunk(insert);
                
                if (insert != "") {
                    outputTokenCount += encoding.encode(insert).length
                } 
                
                finish_reason = part.choices[0]?.finish_reason;
            }


            let models: {[key: string]: any} = {... config.get('models')!}
            
            let model = options['model']

            let ci = getContextModel(models, options.max_tokens, model)

            models[model][ci]['inputCount'] += inputTokenCount
            models[model][ci]['outputCount'] += outputTokenCount

            let cost = inputTokenCount * models[model][ci]['inputPrice']/1000 + outputTokenCount * models[model][ci]['outputPrice']/1000
            
            totalSessionCost += cost

            updateLastCostStatusBarItem(cost)

            config.update('models', models, vscode.ConfigurationTarget.Global);

            if (finish_reason !== 'stop' && finish_reason !== 'user') {
                throw new Error('Stopped. Reason: ' + finish_reason)
            } else if (mode == 'chat') {
                await appendChunk('\n\n[user]\n\n', true);
            }

            resolveFetchResponse!();

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
                    
                    return new Promise<void>(async (resolve, reject) => {
                        // resolveWaitInsert = resolve;
                        // rejectWaitInsert = reject;
                        
                        let loop = true
    
                        token.onCancellationRequested(() => {
                            loop = false;
                            reject("Result has been deleted.")
                        });

                        while (loop) {
                            loop = !(await appendChunk('', false));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }

                        resolve()
                    })

                });
            }

        } catch (error) {
            logerr = error
        } finally {
            completionInProgress = false;
            encoding.free();

            if (rejectFetchResponse) rejectFetchResponse();
            
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

// This method is called when your extension is deactivated
export function deactivate() {}

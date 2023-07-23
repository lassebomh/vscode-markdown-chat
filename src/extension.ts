/* eslint-disable @typescript-eslint/naming-convention */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import OpenAI from 'openai';


function serializeMarkdownChat(text: string): any {
    let options: any = {};

    let metadataSplit = text.split(/^-{3}$/gm);
    let messagesText = text;

    if (metadataSplit.length > 2 && metadataSplit[0] === '') {
        options = <any>yaml.load(metadataSplit[1]);
        messagesText = metadataSplit[2];
    }

    let messagesSplit: string[] = messagesText.split(/(^|\n)\n?> (\w+) *\n{0,2}/g);

    options['messages'] = [];
    
    for(let i=1; i < messagesSplit.length; i+=3){
        options['messages'].push({
            role: messagesSplit[i+1],
            content: messagesSplit[i+2]
        });
    }

    return options;
}

function unserializeMarkdownChat(options: any): string {
    options = {...options};
    
    let messages = options['messages'];
    delete options['messages'];
    
    let messagesText = '';

    for (const message of messages) {
        messagesText += `> ${message.role}\n\n${message.content}`;
        if (message.content) {messagesText += "\n\n";}
    }

    return '---\n' + yaml.dump(options) + '---\n\n' + messagesText;
}

export function activate(context: vscode.ExtensionContext) {

    let setApiKey = vscode.commands.registerCommand('markdown-chat.setApiKey', () => {
        vscode.window.showInputBox({ prompt: 'Enter your OpenAI API Key' }).then(value => {
            if (value !== undefined) {
                let config = vscode.workspace.getConfiguration('markdown-chat');
                config.update('apiKey', value, vscode.ConfigurationTarget.Global);
            }
        });
    });
	
    let completeMarkdownChat = vscode.commands.registerCommand('markdown-chat.sendMarkdownChat', async () => {
        let config = vscode.workspace.getConfiguration('markdown-chat');

        const editor = vscode.window.activeTextEditor;
        if (!editor) {return;}

        const document = editor.document;
		let text = document.getText();

        let options: {stream: true; model: string; messages: any} & {[key: string]: any;} = {
            ...<any>config.get('defaultMarkdownChat'),
            ...serializeMarkdownChat(text)
        };

        if (options.messages.length === 0) {
            vscode.window.showErrorMessage("The chat doesn't contain any messages");
            return;
        }

        const openai = new OpenAI({apiKey: config.get('apiKey')});

        const stream = await openai.chat.completions.create(options, {stream: true});

        const endNewlinesMatch = text.match(/\n*$/);
        const endNewlinesCountDiff = 2 - (endNewlinesMatch ? endNewlinesMatch[0].length : 0);

        let chunks: string[] = [];
        let lastAppend: Date | null = null;

        function appendChunk(chunk: string, force: boolean = false, insertUndo: boolean = false) {
            return new Promise<void>((resolve) => {
                chunks.push(chunk);

                if (!force && lastAppend !== null && (new Date().getTime() - lastAppend.getTime()) < 50) {
                    resolve();
                    return;
                }

                let insert = "".concat(...chunks);
                chunks = [];
                lastAppend = new Date();

                editor!.edit(editBuilder => {
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

        await appendChunk('> assistant\n\n');

        let finish_reason: string | null = null;

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
                finish_reason = 'user';
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

        if (finish_reason !== 'stop' && finish_reason !== 'user') {
            vscode.window.showErrorMessage('Stopped. Reason: ' + finish_reason);
        } else {
            await appendChunk('\n\n> user\n\n', true);
        }

        resolveResponse!();

	});

    let newMarkdownChat = vscode.commands.registerCommand('markdown-chat.newMarkdownChat', async () => {
        let config = vscode.workspace.getConfiguration('markdown-chat');

        let text = unserializeMarkdownChat(config.get('defaultMarkdownChat'));

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

        let markdownChat = serializeMarkdownChat(text);

        console.log(markdownChat);

        if (!('model' in markdownChat)) {
            vscode.window.showErrorMessage('The default chat needs at least "model" in its metadata.');
            return;
        }

        config.update('defaultMarkdownChat', markdownChat, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('The default chat has been set to the current document.');
    });

	context.subscriptions.push(setApiKey, completeMarkdownChat, newMarkdownChat, setMarkdownChatAsDefault);
}

// This method is called when your extension is deactivated
export function deactivate() {}

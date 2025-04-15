import { LightningElement, track, wire } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import { CurrentPageReference } from 'lightning/navigation';
import runInvokeAgent from '@salesforce/apex/InvokeAgentforceForSellersController.runInvokeAgent';

// Imperative Apex calls
import getQuotesByIds from '@salesforce/apex/QuoteTaskCaseController.getQuotesByIds';
import getTasksByIds from '@salesforce/apex/QuoteTaskCaseController.getTasksByIds';
import getCasesByIds from '@salesforce/apex/QuoteTaskCaseController.getCasesByIds';

import agentIcon from '@salesforce/resourceUrl/AgentforceIcon';

export default class InvokeAgentforceForSellersAccount extends LightningElement {
    @track isVisible = false;
    @track isInputVisible = false;
    @track messages = [];  // each msg => { id, text, html, sender, time, isInbound }
    newMessage = '';

    // Spinner for every apex call
    @track isLoading = false;

    subscription;
    channel = '/data/AccountChangeEvent';
    flowInvoked = false;

    agentIconUrl = agentIcon;

    @wire(CurrentPageReference) pageRef;
    get recordId() {
        return this.pageRef?.attributes?.recordId || null;
    }

    connectedCallback() {
        this.subscribeToCdc();
        this.registerErrorListener();
    }

    disconnectedCallback() {
        this.handleUnsubscribe();
    }

    subscribeToCdc() {
        subscribe(this.channel, -1, (response) => {
            const payload = response?.data?.payload;
            console.log('Received CDC event:', JSON.stringify(payload));
            const recordIds = payload?.ChangeEventHeader?.recordIds;
            if (recordIds && recordIds.includes(this.recordId)) {
                const invokeField = payload.Invoke_Agentforce_For_Sellers__c;
                if ((invokeField === true || invokeField === 'true') && !this.flowInvoked) {
                    this.flowInvoked = true;
                    this.isVisible = true;
                    // Trigger apex with "CDC Trigger"
                    this.invokeAgentFlow('CDC Trigger');
                }
            }
        })
        .then(response => {
            this.subscription = response;
            console.log('Subscribed to channel:', response.channel);
        });
    }

    registerErrorListener() {
        onError(error => {
            console.error('EMP API error:', JSON.stringify(error));
        });
    }

    handleUnsubscribe() {
        unsubscribe(this.subscription, response => {
            console.log('Unsubscribed from channel:', response.channel);
        });
    }

    // Show spinner for EVERY call
    invokeAgentFlow(contextMessage) {
        this.isLoading = true;

        runInvokeAgent({
            recordId: this.recordId,
            context: contextMessage
        })
        .then(result => {
            console.log('Flow Response:', result);
            // We'll do an async parse + apex call
            return this.handleFlowResponse(result);
        })
        .catch(error => {
            console.error('Error invoking flow:', error);
        })
        .finally(() => {
            this.isLoading = false;
        });
    }

    // Make this async so we can await apex calls
    async handleFlowResponse(flowResponse) {
        let text = flowResponse || '';
        try {
            const data = JSON.parse(flowResponse);
            text = data.value || flowResponse;
        } catch (e) {
            // If not JSON, just use raw text
        }

        // Check for duplicate inbound
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.isInbound && lastMsg.text === text) {
            console.log('Duplicate inbound response, skipping...');
            return;
        }

        // Create the new inbound message
        const now = new Date();
        const newMsg = {
            id: now.valueOf().toString(),
            text: text,   // raw text
            html: text,   // we'll do replacements in this
            sender: 'Agentforce',
            time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ariaLabel: `said Agentforce at ${now.toLocaleTimeString()}`,
            isInbound: true
        };

        // 1) Parse IDs
        const quoteRegex = /(0Q0[0-9A-Za-z]+)/g;
        const taskRegex = /(00T[0-9A-Za-z]+)/g;
        const caseRegex = /(500[0-9A-Za-z]+)/g;

        const quoteIds = [];
        const taskIds = [];
        const caseIds = [];

        let match;
        while ((match = quoteRegex.exec(text)) !== null) {
            quoteIds.push(match[1]);
        }
        while ((match = taskRegex.exec(text)) !== null) {
            taskIds.push(match[1]);
        }
        while ((match = caseRegex.exec(text)) !== null) {
            caseIds.push(match[1]);
        }

        // 2) Imperative apex calls in parallel
        // build maps { Id -> friendlyName }
        let quoteMap = {};
        let taskMap = {};
        let caseMap = {};

        try {
            const [quoteData, taskData, caseData] = await Promise.all([
                getQuotesByIds({ quoteIds }),
                getTasksByIds({ taskIds }),
                getCasesByIds({ caseIds })
            ]);

            // build quoteMap { "0Q0xxx" : "Q-00045" }
            quoteData.forEach(q => {
                quoteMap[q.Id] = q.QuoteNumber;
            });
            // build taskMap { "00Txxx" : "Run the numbers..." }
            taskData.forEach(t => {
                taskMap[t.Id] = t.Subject;
            });
            // build caseMap { "500xxx" : "Some Case Subject" }
            caseData.forEach(c => {
                // Use c.Subject or c.CaseNumber or both
                caseMap[c.Id] = c.Subject;
            });
        } catch (err) {
            console.error('Error fetching records:', err);
        }

        // 3) Now do the actual replacement in newMsg.html
        let replaced = newMsg.html;

        // For each ID in quoteMap, replace in the text
        for (let qId in quoteMap) {
            const friendlyName = quoteMap[qId];
            const link = `<a href="${window.location.origin}/lightning/r/Quote/${qId}/view" target="_blank">${friendlyName}</a>`;
            const pattern = new RegExp(qId, 'g');
            replaced = replaced.replace(pattern, link);
        }

        // For tasks
        for (let tId in taskMap) {
            const friendlyName = taskMap[tId];
            const link = `<a href="${window.location.origin}/lightning/r/Task/${tId}/view" target="_blank">${friendlyName}</a>`;
            const pattern = new RegExp(tId, 'g');
            replaced = replaced.replace(pattern, link);
        }

        // For cases
        for (let cId in caseMap) {
            const friendlyName = caseMap[cId];
            const link = `<a href="${window.location.origin}/lightning/r/Case/${cId}/view" target="_blank">${friendlyName}</a>`;
            const pattern = new RegExp(cId, 'g');
            replaced = replaced.replace(pattern, link);
        }

        newMsg.html = replaced;

        // 4) Add to messages
        this.messages = [...this.messages, newMsg];
    }

    toggleChatInput() {
        this.isInputVisible = !this.isInputVisible;
    }

    handleNewMessageChange(event) {
        this.newMessage = event.target.value;
    }

    handleKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.handleSend();
        }
    }

    handleSend() {
        if (!this.newMessage.trim()) {
            return;
        }

        const now = new Date();
        const outMsg = {
            id: now.valueOf().toString(),
            text: this.newMessage.trim(),
            sender: 'Rep',
            time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ariaLabel: `said Rep at ${now.toLocaleTimeString()}`,
            isInbound: false
        };
        this.messages = [...this.messages, outMsg];

        const contextMessage = this.newMessage.trim();
        this.newMessage = '';
        this.invokeAgentFlow(contextMessage);
    }

    // In renderedCallback, we set the bubble's innerHTML for inbound messages
    renderedCallback() {
        this.messages.forEach(msg => {
            if (msg.isInbound && msg.html) {
                const bubble = this.template.querySelector(`div[data-msgid="${msg.id}"]`);
                if (bubble) {
                    bubble.innerHTML = msg.html; // inject the replaced HTML
                }
            }
        });
    }
}

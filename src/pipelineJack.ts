import * as vscode from 'vscode';
import * as xml2js from "xml2js";
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

import { getPipelineJobConfig, readjson, writejson } from './utils';
import { sleep } from './utils';
import { JenkinsService } from './jenkinsService';
import { SharedLibApiManager, SharedLibVar } from './sharedLibApiManager';
import { JackBase } from './jack';

const parseXmlString = util.promisify(xml2js.parseString) as any as (xml: string) => any;

export class PipelineJack extends JackBase {
    private config: any;
    private cachedJob?: any;
    private activeJob?: any;
    private readonly sharedLib: SharedLibApiManager;
    private readonly jenkins: JenkinsService;
    private readonly messageItem: vscode.MessageItem = {
        title: 'Okay'
    };

    constructor() {
        super('Pipeline Jack');
        this.config = vscode.workspace.getConfiguration('jenkins-jack.pipeline');
        vscode.workspace.onDidChangeConfiguration(event => { this.updateSettings(); });
        this.jenkins = JenkinsService.instance();
        this.sharedLib = SharedLibApiManager.instance();
    }

    public getCommands(): any[] {
        let commands: any[] = [];

        // Displayed commands altered by active pipeline build.
        if (undefined === this.activeJob) {
            commands.push({
                label: "$(triangle-right)  Pipeline: Execute",
                description: "Executes the current groovy file as a pipeline job.",
                target: async () => await this.executePipeline(),
            });
            commands.push ({
                label: "$(repo-sync)  Pipeline: Update",
                description: "Updates the current view's associated pipeline job configuration.",
                target: async () => await this.updatePipeline(),
            });
        }
        else {
            commands.push({
                label: "$(primitive-square)  Pipeline: Abort",
                description: "Aborts the active pipeline job initiated by Execute.",
                alwaysShow: false,
                target: async () => await this.abortPipeline(),
            });
        }

        commands = commands.concat([
            {
                label: "$(file-text)  Pipeline: Shared Library Reference",
                description: "Provides a list of steps from the Shares Library and global variables.",
                target: async () => await this.showSharedLibraryReference(),
            }
        ]);
        return commands;
    }

    public updateSettings() {
        this.config = vscode.workspace.getConfiguration('jenkins-jack.pipeline');
    }

    // @ts-ignore
    private async executePipeline() {
        // Validate it's valid groovy source.
        var editor = vscode.window.activeTextEditor;
        if (undefined === editor) { return; }
        if ("groovy" !== editor.document.languageId) {
            return;
        }

        // Validate there is an associated file with the view/editor.
        if ("untitled" === editor.document.uri.scheme) {
            // TODO: prompt the save dialog for the Untitled file.
            this.showInformationMessage('Must save the document before you run.', this.messageItem);
            return;
        }

        // Grab filename to use as the Jenkins job name.
        var jobName = path.parse(path.basename(editor.document.fileName)).name;

        // Grab source from active editor.
        let source = editor.document.getText();
        if ("" === source) { return; }

        // Build the pipeline.
        this.activeJob = await this.build(source, jobName);
        if (undefined === this.activeJob) { return; }

        // Stream the output. Yep.
        await this.jenkins.streamBuildOutput(
            this.activeJob.fullName,
            this.activeJob.nextBuildNumber,
            this.outputChannel);

        this.cachedJob = this.activeJob;
        this.activeJob = undefined;
    }

    /**
     * Aborts the active pipeline build.
     */
    public async abortPipeline() {
        if (undefined === this.activeJob) { return; }
        await this.jenkins.client.build.stop(this.activeJob.fullName, this.activeJob.nextBuildNumber).then(() => { });
        this.activeJob = undefined;
    }

    // @ts-ignore
    private async updatePipeline() {
        // Validate it's valid groovy source.
        var editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        if ("groovy" !== editor.document.languageId) {
            return;
        }

        // Grab filename to use as (part of) the Jenkins job name.
        var jobName = path.parse(path.basename(editor.document.fileName)).name;

        // Grab source from active editor.
        let source = editor.document.getText();
        if ("" === source) { return; }

        await this.update(source, jobName);
    }

    /**
     * Displays a list of Shared Library steps/vars for the user to select.
     * On selection, will display a web-view of the step's documentation.
     */
    public async showSharedLibraryReference() {
        let lib = await this.sharedLib.refresh() as SharedLibVar[];
        let result = await vscode.window.showQuickPick(lib);
        if (undefined === result) { return; }
        if (this.config.browserSharedLibraryRef) {
            if (undefined === this.cachedJob) {
                this.jenkins.openBrowserAt(`pipeline-syntax/globals#${result.label}`);
            }
            else {
                this.jenkins.openBrowserAt(`job/${this.cachedJob.fullName}/pipeline-syntax/globals#${result.label}`);
            }
        }
        else {
            const panel = vscode.window.createWebviewPanel(
                'Pipeline Shared Library',
                result.label,
                vscode.ViewColumn.Beside,
                {}
            );
            panel.webview.html = `<html>${result.descriptionHtml}</html>`;
        }
    }

    /**
     * Creates or update the provides job with the passed Pipeline source.
     * @param source The scripted Pipeline source.
     * @param jobName The Jenkins Pipeline job name.
     * @returns A Jenkins 'job' json object.
     */
    public async createUpdate(source: string, jobName: string): Promise<any> {
        let xml = getPipelineJobConfig();
        let job = await this.jenkins.getJob(jobName);

        // If job already exists, grab the job config xml from Jenkins.
        if (job) {
            // Grab job's xml configuration.
            xml = await this.jenkins.client.job.config(jobName).then((data: any) => {
                return data;
            }).catch((err: any) => {
                // TODO: Handle better
                console.log(err);
                throw err;
            });
        }

        // Inject the provided script/source into the job configuration.
        let parsed = await parseXmlString(xml);
        let root = parsed['flow-definition'];
        root.definition[0].script = source;
        root.quietPeriod = 0;
        xml = new xml2js.Builder().buildObject(parsed);

        if (!job) {
            let r = await this.showInformationMessage(
                `"${jobName}" doesn't exist. Do you want us to create it?`, { modal: true }, "Yes");
            if (undefined === r) { return undefined; }

            console.log(`${jobName} doesn't exist. Creating...`);
            job = await this.jenkins.client.job.create(jobName, xml);
        }
        else {
            console.log(`${jobName} already exists. Updating...`);
            await this.jenkins.client.job.config(jobName, xml);
        }
        console.log(`Successfully updated Pipeline: ${jobName}`);
        return job;
    }

    /**
     * Handles the build parameter input flow for a Pipeline job
     * and the creation/updating of the associated *.params.json
     * file for the active editor's groovy file.
     * @param job The jenkins Pipeline job json object.
     * @returns A parameters key/value json object.
     *          Undefined if job has no parameters.
     *          An empty json if pamaeters are disabled.
     */
    public async buildParameterInput(
        job: any,
        progress: vscode.Progress<{ message?: string | undefined; increment?: number | undefined; }>): Promise<any> {

        // Validate job has parameters.
        let paramProperty = job.property.find((p: any) => p._class === "hudson.model.ParametersDefinitionProperty");
        if (undefined === paramProperty) { return undefined; }

        // Validate configuration enabled.
        if (!this.config.params.enabled) { return {}; }

        // Validate active editor.
        if (undefined === vscode.window.activeTextEditor) {
            throw new Error("No active editor to grab document path.");
        }
        let groovyScriptPath = vscode.window.activeTextEditor.document.uri.fsPath;

        // Generate params path.
        let parsed = path.parse(groovyScriptPath);
        let paramsFileName = `${parsed.name}.params.json`;
        let paramsPath = path.join(parsed.dir, paramsFileName);

        // Gather parameter name/default-value json.
        let infoMessage = `${paramsPath} created!`;
        let paramsJson: any = {};
        for (let p of paramProperty.parameterDefinitions) {
            paramsJson[p.name] = p.defaultParameterValue.value;
        }

        let jsonParamsFileExist = fs.existsSync(paramsPath);

        // If there are existing parameters for this job, update the job's
        // defaults with the saved values.
        if (jsonParamsFileExist) {
            infoMessage = `${paramsPath} updated!`;

            let json = readjson(paramsPath);
            for (let key in json) { paramsJson[key] = json[key]; }
        }

        // Write the parameters file local to the editor's file.
        writejson(paramsPath, paramsJson);
        progress.report({ message: infoMessage });

        // If there were no parameters file originally, present the defaults
        // to the user in the editor to edit.
        if (!jsonParamsFileExist) {
            // Open the parameters file for the user to edit and wait
            // on it's closing.
            let openPath = vscode.Uri.parse(`file:///${paramsPath}`);
            progress.report({ message: `${this.name}: Close ${paramsFileName} to continue build.` });
            await vscode.window.showTextDocument(openPath, { viewColumn: vscode.ViewColumn.Beside });

            // TODO: Don't know a better way on awaiting on a particular
            // text editor closing.
            let paramsEditorActive = undefined;
            do {
                await sleep(1000);
                paramsEditorActive = vscode.window.visibleTextEditors.find(
                    (e: vscode.TextEditor) => e.document.uri.path.includes(paramsFileName));
            } while(undefined !== paramsEditorActive);

        }

        // Read saved/updated parameters and return to caller.
        return readjson(paramsPath);
    }

    /**
     * Updates the targeted Pipeline job with the given script/source.
     * @param source The pipeline script source to update to.
     * @param job The name of the job to update.
     */
    public async update(source: string, job: string) {
        if (undefined !== this.activeJob) {
            this.showWarningMessage(`Already building/streaming - ${this.activeJob.fullName}: #${this.activeJob.nextBuildNumber}`, undefined);
            return;
        }

        this.outputChannel.show();
        this.outputChannel.clear();

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating ${job}`,
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                this.showWarningMessage(`User canceled pipeline update.`, undefined);
            });
            progress.report({ increment: 50 });
            return new Promise(async resolve => {
                await this.createUpdate(source, job);
                resolve();
            });
        });
    }

    /**
     * Builds the targeted job with the provided Pipeline script/source.
     * @param source Scripted Pipeline source.
     * @param jobName The name of the job.
     * @returns The Jenkins job json object of the build, where nextBuildNumber
     *          represents the active build number.
     *          Undefined if cancellation or failure to complete flow.
     */
    public async build(source: string, job: string) {

        if (undefined !== this.activeJob) {
            this.showWarningMessage(`Already building/streaming - ${this.activeJob.fullName}: #${this.activeJob.nextBuildNumber}`, undefined);
            return undefined;
        }

        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Pipeline ${job}`,
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                this.showWarningMessage(`User canceled pipeline build.`, undefined);
            });

            progress.report({ increment: 0, message: `Creating/updating Pipeline job.` });
            let currentJob = await this.createUpdate(source, job);
            if (undefined === currentJob) { return; }

            let jobName = currentJob.fullName;
            let buildNum = currentJob.nextBuildNumber;

            if (token.isCancellationRequested) { return undefined;  }

            // TODO: config conditional
            progress.report({ increment: 20, message: `Waiting on build paramter input...` });
            let params = {};
            try {
                params = await this.buildParameterInput(currentJob, progress);
            } catch (err) {
                this.showWarningMessage(err.message, undefined);
                return undefined;
            }

            if (token.isCancellationRequested) { return undefined;  }

            progress.report({ increment: 20, message: `Building "${jobName} #${buildNum}` });
            let buildOptions = params !== undefined ? { name: jobName, parameters: params } : { name: jobName };
            await this.jenkins.client.job.build(buildOptions).catch((err: any) => {
                console.log(err);
                throw err;
            });

            if (token.isCancellationRequested) { return undefined;  }

            progress.report({ increment: 30, message: `Waiting for build to be ready...` });
            try {
                await this.jenkins.buildReady(jobName, buildNum);
            } catch (err) {
                this.showWarningMessage(`Timed out waiting for build: ${jobName} #${buildNum}`, undefined);
                return undefined;
            }
            progress.report({ increment: 30, message: `Build is ready!` });
            return currentJob;
        });
    }
}
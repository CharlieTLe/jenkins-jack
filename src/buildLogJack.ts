import * as vscode from 'vscode';
import { JenkinsService } from "./jenkinsService";
import { JackBase } from './jack';

export class BuildLogJack extends JackBase {
    private readonly jenkins: JenkinsService;

    constructor() {
        super('Build Log Jack');
        this.jenkins = JenkinsService.instance();
    }

    public getCommands(): any[] {
        return [{
                label: "$(cloud-download)  Build Log: Download",
                description: "Select a job and build to download the log.",
                target: async () => await this.download()
        }];
    }

    /**
     * Downloads a build log for the user by first presenting a list
     * of jobs to select from, and then a list of build numbers for
     * the selected job.
     */
    public async download() {
        let jobs = await this.jenkins.getJobs(undefined);
        if (undefined === jobs) { return; }
        for (let job of jobs) {
            job.label = job.fullName;
        }

        // Ask which job they want to target.
        let job = await vscode.window.showQuickPick(jobs);
        if (undefined === job) { return; }

        // Ask what build they want to download.
        let buildNumbers = await this.jenkins.getBuildNumbersFromUrl(job.url);
        let buildNumber = await vscode.window.showQuickPick(buildNumbers);
        if (undefined === buildNumber) { return; }

        // Stream it. Stream it until the editor crashes.
        await this.jenkins.streamBuildOutput(job.label, parseInt(buildNumber), this.outputChannel);
    }
}
import puppeteer from "puppeteer";
import path from 'path';
import os from "os";

import { mkdir } from "node:fs/promises";

var command_line_args = { verbose: true }; // defaults
for (let i = 2; i < Bun.argv.length; i++) {
    if (!Bun.argv[i].startsWith("--")) {
        throw new Error("unexpected command line argument " + Bun.argv[i] + " at position " + i);
    }
    if (!Bun.argv[i].includes("=")) {
        command_line_args[Bun.argv[i].slice(2)] = true;
    } else {
        let spl = Bun.argv[i].split("=");
        command_line_args[spl[0].slice(2)] = spl.slice(1).join("=");
    }
}

if (command_line_args.verbose) {
    console.log("command_line_args", command_line_args);
}

const { listenon, port, maxbrowsers, verbose, homedir } = command_line_args;
const nport = parseInt(port);
if (typeof nport !== 'number') {
    throw new Error("we need port to represent a valid number");
}
const nmaxbrowsers = parseInt(maxbrowsers);
if (isNaN(nmaxbrowsers) || typeof nmaxbrowsers !== 'number') {
    throw new Error("we need maxbrowsers to represent a valid number");
}
if (nmaxbrowsers < 1) {
    throw new Error("we need maxbrowsers to be at least 1");
}
if (typeof homedir !== 'string' || homedir.length === 0) {
    throw new Error("we need a home directory defined with command line argument --homedir");
}

var browserInstances = new Array(nmaxbrowsers).fill(null);
var browserFirstPages = new Array(nmaxbrowsers).fill(null);
var browserInstancesInUse = new Array(nmaxbrowsers).fill(true);
var waitingqueue = [];
var closed = false;

initialize();

if (verbose) {
    console.log("browserInstancesInUse", browserInstancesInUse);
}

function releaseBrowser(instanceIndex) {
    if (verbose) {
        console.log("releaseBrowser", instanceIndex);
        console.log("waitingqueue.length", waitingqueue.length);
    }

    if (waitingqueue.length > 0) {
        let fifoWaiter = undefined;
        while (fifoWaiter === undefined && waitingqueue.length > 0) { // gc stale queue ticket where the requester timed out
            fifoWaiter = waitingqueue.shift().resolve;
        }

        if (verbose) {
            console.log("waitingqueue.length", waitingqueue.length, fifoWaiter !== undefined);
        }

        if (fifoWaiter !== undefined) {
            fifoWaiter(instanceIndex);
        } else {
            browserInstancesInUse[instanceIndex] = false;
        }
    } else {
        browserInstancesInUse[instanceIndex] = false;
    }
}

async function initialize() {
    try {
        for (let i = 0; i < browserInstances.length; i++) {
            if (closed) {
                return
            }
            if (command_line_args.launchargs !== undefined) {
                let tmp = JSON.parse(command_line_args.launchargs);
                browserInstances[i] = await puppeteer.launch({ args: tmp });
            } else {
                browserInstances[i] = await puppeteer.launch();
            }
            if (closed) {
                return
            }
            browserFirstPages[i] = await browserInstances[i].newPage();
            if (closed) {
                return
            }

            releaseBrowser(i);
        }
    } catch (e) {
        console.error(e);
        await terminate(1);
    }
}

async function terminate(exitcode) {
    if (closed) {
        return
    }
    closed = true;
    if (verbose) {
        console.log("Closing Puppeteer browsers...");
    }
    for (let i = 0; i < browserInstances.length; i++) {
        if (browserInstances[i] !== null) {
            try {
                await browserInstances[i].close();
            } catch (e) {
                if (verbose) {
                    console.log("we could not close browser instance " + i + ": " + e);
                }
            }
        }
    }
    process.exit(exitcode);
}

process.on("exit", (code) => {
    terminate(0);
});

Bun.serve({
    port: nport,
    hostname: listenon,
    async fetch(_req) {
        const pathname = new URL(_req.url).pathname;

        switch (pathname) {
            default:
                return new Response("404: Route " + pathname + " not found", {
                    status: 404,
                });
            case "/puppeteer_pseudo_rpc":
                let body;
                try {
                    body = await _req.json();
                } catch (e) {
                    return new Response("400: we could not read the json body " + e, {
                        status: 400,
                    });
                }

                let instance = null;
                let instanceIndex = null;
                for (let i = 0; i < browserInstancesInUse.length; i++) {
                    if (!browserInstancesInUse[i]) {
                        browserInstancesInUse[i] = true;
                        instance = browserInstances[i];
                        instanceIndex = i;
                        break;
                    }
                }

                if (verbose) {
                    console.log("instanceIndex", instanceIndex);
                }

                if (instance === null) {
                    // we use a reference so we can mark the promise as stale if we time out
                    // it will get gc by the next queue shift
                    let wgref = { resolve: undefined };
                    let wg = new Promise((resolve, _) => {
                        wgref.resolve = resolve;
                        waitingqueue.push(wgref);
                    });
                    let timeout = new Promise(resolve => setTimeout(() => { resolve(null); }, 60000));
                    instanceIndex = await Promise.race([wg, timeout]);

                    if (verbose) {
                        console.log("instanceIndex promise", instanceIndex, wgref.resolve === undefined);
                    }

                    if (instanceIndex === null) {
                        wgref.resolve();
                        wgref.resolve = undefined;
                        return new Response("408: we timed out waiting for a browser instance to become available", {
                            status: 408,
                        });
                    }
                    instance = browserInstances[instanceIndex];
                }

                // we nest the logic in a function so we can call releaseBrowser when it is done no matter where it returned
                // and also avoid forgetting to release at some return statement
                let runcommand = async function () {
                    /*
                        body = {
                            returnvariables: []string,
                            calls: [
                                {
                                    targetvarname: string,
                                    methodreceiver: varname or startingpage or browser
                                    methodname: string,
                                    parameters: [#varname, "rawval", "function(el) {return el.textContent;}"],
                                }
                            ]
                        }
                    */
                    if (!Array.isArray(body.calls)) {
                        return new Response("400: we need the json body to contain the array property calls", {
                            status: 400,
                        });
                    }
                    let variables = {};
                    for (let i = 0; i < body.calls.length; i++) {
                        if (verbose) {
                            console.log("call", body.calls[i]);
                        }

                        if (!Array.isArray(body.calls[i].parameters)) {
                            return new Response("400: we need every call to contain the array property parameters, even if it is empty", {
                                status: 400,
                            });
                        }
                        if (typeof body.calls[i].methodname !== 'string' || body.calls[i].methodname.length === 0) {
                            return new Response("400: we need the field methodname provided for every element in the calls array", {
                                status: 400,
                            });
                        }
                        let receiver;
                        switch (body.calls[i].methodreceiver) {
                            default:
                                receiver = variables[body.calls[i].methodreceiver];
                                if (receiver === undefined) {
                                    return new Response("400: we do not recognize method receiver: " + body.calls[i].methodreceiver, {
                                        status: 400,
                                    });
                                }
                            case "startingpage":
                                receiver = browserFirstPages[instanceIndex];
                                break;
                            case "browser":
                                receiver = instance;
                                break;
                        }

                        for (let p = 0; p < body.calls[i].parameters.length; p++) {
                            if (typeof body.calls[i].parameters[p] === "string") {
                                if (body.calls[i].parameters[p].startsWith("file:///")) {
                                    if (containsDotDot(body.calls[i].parameters[p])) {
                                        return new Response("403: double dots in pathnames are forbidden to enhance security", {
                                            status: 403,
                                        });
                                    }
                                    let localAbsolutePath = path.join(homedir, Bun.fileURLToPath(body.calls[i].parameters[p]));
                                    if (localAbsolutePath[0] != "/") {
                                        localAbsolutePath = "/" + localAbsolutePath;
                                    }
                                    await mkdir(os.path.dirname(localAbsolutePath), { recursive: true, mode: 0700 });
                                    body.calls[i].parameters[p] = "file://" + path.join(homedir, Bun.fileURLToPath(body.calls[i].parameters[p]));
                                } else if (body.calls[i].parameters[p].startsWith("#")) {
                                    let vname = body.calls[i].parameters[p].slice(1);

                                    if (verbose) {
                                        console.log("converting parameter", body.calls[i].parameters[p], "to", vname);
                                    }

                                    body.calls[i].parameters[p] = variables[vname];

                                    if (body.calls[i].parameters[p] === undefined) {
                                        return new Response("400: we did not find variable in parameters: " + vname, {
                                            status: 400,
                                        });
                                    }
                                } else if (body.calls[i].parameters[p].startsWith("function(")) {
                                    body.calls[i].parameters[p] = body.calls[i].parameters[p].slice(9);
                                    let argend = body.calls[i].parameters[p].indexOf(")");
                                    let args = body.calls[i].parameters[p].slice(0, argend).trim().split(",").map(v => v.trim());
                                    body.calls[i].parameters[p] = body.calls[i].parameters[p].slice(argend + 1).trim();
                                    args.push(body.calls[i].parameters[p].slice(1, body.calls[i].parameters[p].length - 2).trim()); // remove { }

                                    if (verbose) {
                                        console.log("creating new Function with arguments", args);
                                    }

                                    body.calls[i].parameters[p] = new Function(...args);
                                }
                            }
                        }

                        if (verbose) {
                            console.log("formated parameters", ...body.calls[i].parameters);
                        }

                        if (verbose) {
                            console.log(JSON.stringify(receiver));
                            console.log(body.calls[i].methodname);
                        }

                        // We need to wrap Puppeteer classes in this Proxy, otherwise it won't let us dynamically access its
                        // classes methods
                        let wrappedReceiver = new Proxy(receiver, {
                            get(target, propKey, receiverObj) {
                                if (typeof target[propKey] === 'function') {
                                    return (...args) => target[propKey](...args);
                                }
                                return target[propKey];
                            }
                        });

                        let val;
                        try {
                            val = await wrappedReceiver[body.calls[i].methodname](...body.calls[i].parameters);
                        } catch (e) {
                            return new Response("500: we encountered the following error: " + e + " for method " + body.calls[i].methodname + " on receiver " + body.calls[i].methodreceiver, {
                                status: 500,
                            });
                        }
                        if (typeof body.calls[i].targetvarname === 'string' && body.calls[i].targetvarname.length > 0) {
                            variables[body.calls[i].targetvarname] = val;
                        }
                    }

                    let response = { success: true };
                    if (Array.isArray(body.returnvariables) && body.returnvariables.length > 0) {
                        response.variables = {};
                        for (let v = 0; v < body.returnvariables.length; v++) {
                            response.variables = variables[body.returnvariables[v]];
                        }
                    }
                    return Response.json(response, {
                        status: 200
                    });
                };

                let resp
                try {
                    resp = await runcommand();
                } catch(e) {
                    return new Response("500: " + e, {
                        status: 500,
                    });
                }

                if (verbose) {
                    console.log("returning response");
                }

                releaseBrowser(instanceIndex);
                return resp;
        }
    },
});

// Check for .. in the path and respond with an error if it is present
// otherwise users could access any file on the server
function containsDotDot(v) {
    if (!v.includes("..")) {
        return false;
    }
    const fields = v.split(/[/\\]/);
    for (let i = 0; i < fields.length; i++) {
        if (fields[i] === "..") {
            return true;
        }
    }
    return false;
}
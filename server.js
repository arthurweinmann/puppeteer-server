import puppeteer from "https://deno.land/x/puppeteer@16.2.0/mod.ts";
import { parse } from "https://deno.land/std@0.83.0/flags/mod.ts";

const { listenon, port, maxbrowsers } = parse(Deno.args);
const nport = parseInt(port);
if (typeof nport !== 'number') {
    throw new Error("we need port to represent a valid number");
}
const nmaxbrowsers = parseInt(maxbrowsers);
if (typeof nmaxbrowsers !== 'number') {
    throw new Error("we need maxbrowsers to represent a valid number");
}
if (nmaxbrowsers < 1) {
    throw new Error("we need maxbrowsers to be at least 1");
}

var browserInstances = new Array(maxbrowsers).fill(null);
var browserFirstPages = new Array(maxbrowsers).fill(null);
var browserInstancesInUse = new Array(maxbrowsers).fill(true);
var waitingqueue = [];
var closed = false;

initialize();

async function initialize() {
    try {
        for (let i = 0; i < browserInstances.length; i++) {
            if (closed) {
                return
            }
            browserInstances[i] = await puppeteer.launch();
            if (closed) {
                return
            }
            browserFirstPages[i] = await browserInstances[i].newPage();
            if (closed) {
                return
            }

            if (waitingqueue.length > 0) {
                let fifoWaiter = waitingqueue.shift();
                fifoWaiter(i);
            } else {
                browserInstancesInUse[i] = false;
            }
        }
    } catch (e) {
        console.error(e);
        await terminate(1);
    }
}

async function terminate(exitcode) {
    closed = true;
    console.log("Received SIGINT signal, closing Puppeteer browsers...");
    for (let i = 0; i < browserInstances.length; i++) {
        if (browserInstances[i] !== null) {
            await browserInstances[i].close();
        }
    }
    Deno.exit(exitcode);
}

for await (const _ of Deno.signal(Deno.Signal.SIGINT)) {
    await terminate(0);
}

Deno.serve({ port: nport, hostname: listenon }, async (_req, _info) => {
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
            if (instance === null) {
                let wg = new Promise((resolve, _) => { waitingqueue.push(resolve) });
                let timeout = new Promise(resolve => setTimeout(() => { resolve(null); }, 60000));
                instanceIndex = await Promise.race([wg, timeout]);
                if (instanceIndex === null) {
                    return new Response("408: we timed out waiting for a browser instance to become available", {
                        status: 408,
                    });
                }
                instance = browserInstances[instanceIndex];
            }

            /*
                body = {
                    returnvariables: []string,
                    calls: [
                        {
                            targetvarname: string,
                            methodreceiver: varname or startingpage or browser
                            methodname: string,
                            parameters: [#varname, "rawval"],
                        }
                    ]
                }
            */
            if (!Array.isArray(body.calls)) {
                return new Response("400: we need the json body to contain the array property calls", {
                    status: 400,
                });
            }
            if (!Array.isArray(body.parameters)) {
                return new Response("400: we need the json body to contain the array property parameters, even if it is empty", {
                    status: 400,
                });
            }
            let variables = {};
            for (let i = 0; i < body.calls.length; i++) {
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
                let mth = receiver[body.calls[i].methodname];
                if (mth === undefined) {
                    return new Response("400: we do not recognize method name: " + body.calls[i].methodname, {
                        status: 400,
                    });
                }
                for (let p = 0; p < body.parameters.length; p++) {
                    if (body.parameters[p].startsWith("#")) {
                        let vname = body.parameters[p].slice(1);
                        body.parameters[p] = variables[vname];
                        if (body.parameters[p] === undefined) {
                            return new Response("400: we did not find variable in parameters: " + vname, {
                                status: 400,
                            });
                        }
                    }
                }
                let val;
                try {
                    val = await mth(...body.parameters);
                } catch (e) {
                    return new Response("501: we encountered the following error: " + e, {
                        status: 501,
                    });
                }
                if (typeof body.calls[i].targetvarname === 'string' && body.calls[i].targetvarname.length > 0) {
                    variables[body.calls[i].targetvarname] = val;
                }
            }

            if (waitingqueue.length > 0) {
                let fifoWaiter = waitingqueue.shift();
                fifoWaiter(instanceIndex);
            } else {
                browserInstancesInUse[instanceIndex] = false;
            }

            let response = { success: true };
            if (Array.isArray(body.returnvariables) && body.returnvariables.length > 0) {
                response.variables = {};
                for (let v = 0; v < body.returnvariables.length; v++) {
                    response.variables = variables[body.returnvariables[v]];
                }
            }
            return new Response(response, {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
    }
});
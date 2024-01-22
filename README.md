# Puppeteer HTTP server

Make Puppeteer accessible through a simple HTTP server. This allows you to use headless chrome and also puppeteer from other programming languages without suffering from the cold start cost each time.

# Warning 

This is probably not safe if you expose this server on the internet, directly to users. It is intended to be behind a trusted proxy.

# How to use

Build the binary yourself by following [.github/workflows/release.yml](.github/workflows/release.yml) locally or by forking this repository.
You can also download the binary file already compiled in the release section of this repository.

Run it, give it the address and port it will listen, and also the maximum number of headless chrome to start:
`./puppeteerserver --listenon 127.0.0.1 --port 8085 --maxbrowsers 3`

Finally, access your new and shiny constantly ready pool of puppeteers:
```bash
curl -X POST http://127.0.0.1:8085/puppeteer_pseudo_rpc \
     -H "Content-Type: application/json" \
     -d @- << EOF
{
    returnvariables: ["names of a variable you defined in calls and would like to return in the response"],
    calls: [
        {
            targetvarname: "the name of the variable into which to save the result of the method call, for example page",
            methodreceiver: "previously created variable name" | "startingpage" | "browser"
            methodname: "for example screenshot",
            parameters: [{path: "screenshot.png"}, "#varname: start a string with # to replace it by the value a previously defined variable holds"],
        }
    ]
}
EOF
```
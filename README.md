# Puppeteer Pseudo-RPC HTTP server

Make Puppeteer accessible through a simple HTTP server. This allows you to use headless chrome and also puppeteer from other programming languages without suffering from the cold start cost each time.

# Warning 

This server is probably not safe to expose directly to users on the web. It should be behind a trusted web server implemented in another programming language, and only accessible from the machine it is running on or from a VPN.

# How to use

Clone this repository or download the zip in the release section. 

Start the server with:
```sh
bun run server.js --homedir=/path/to/home/directory --verbose --listenon=10.0.0.2 --port=8085 --maxbrowsers=1 --launchargs='["--no-sandbox", "--disable-gpu", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]'
```

Access your new and shiny constantly ready pool of puppeteers:
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
            parameters: [{path: "screenshot.png"}, "#varname: start a string with # to replace it by the value of a previously defined variable"],
        }
    ]
}
EOF
```

Response Example:
```
{
    success: true,
    variables: {
        "varname": "variable value",
    },
}
```

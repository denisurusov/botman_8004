const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Contract addresses — set via env vars or edit constants
const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY_ADDRESS || "0x...";
const REVIEWER_CONTRACT_ADDRESS = process.env.REVIEWER_CONTRACT_ADDRESS || "";
const APPROVER_CONTRACT_ADDRESS = process.env.APPROVER_CONTRACT_ADDRESS || "";

async function main() {
    if (IDENTITY_REGISTRY_ADDRESS === "0x...") {
        throw new Error(
            "Set IDENTITY_REGISTRY_ADDRESS env var or edit the constant in this script.\n" +
            "Example: $env:IDENTITY_REGISTRY_ADDRESS='0xYourAddress'; npx hardhat run scripts/register-mocks.js --network localhost"
        );
    }

    const signers = await hre.ethers.getSigners();
    const identity = await hre.ethers.getContractAt("IdentityRegistryUpgradeable", IDENTITY_REGISTRY_ADDRESS);

    const agentsDir = path.join(__dirname, "..", "agents");
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json")).sort();

    console.log(`Registering ${agentFiles.length} agents against ${IDENTITY_REGISTRY_ADDRESS}`);
    if (REVIEWER_CONTRACT_ADDRESS) console.log(`  Reviewer oracle: ${REVIEWER_CONTRACT_ADDRESS}`);
    if (APPROVER_CONTRACT_ADDRESS) console.log(`  Approver oracle: ${APPROVER_CONTRACT_ADDRESS}`);
    console.log();

    for (let i = 0; i < agentFiles.length; i++) {
        const file = agentFiles[i];
        const owner = signers[i + 1] ?? signers[0]; // signers[1..N], fall back to deployer

        const card = JSON.parse(fs.readFileSync(path.join(agentsDir, file), "utf8"));
        const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;

        // Determine oracle address based on capabilities
        let oracleAddr = null;
        if (card.capabilities?.includes("code-review") && REVIEWER_CONTRACT_ADDRESS) {
            oracleAddr = REVIEWER_CONTRACT_ADDRESS;
        } else if (card.capabilities?.includes("approve-pr") && APPROVER_CONTRACT_ADDRESS) {
            oracleAddr = APPROVER_CONTRACT_ADDRESS;
        }

        let tx, receipt;
        if (oracleAddr) {
            // register(string agentURI, MetadataEntry[] metadata, address oracleAddress)
            tx = await identity.connect(owner)["register(string,(string,bytes)[],address)"](
                uri, [], oracleAddr
            );
        } else {
            // register(string agentURI) — no oracle binding
            tx = await identity.connect(owner)["register(string)"](uri);
        }
        receipt = await tx.wait();

        const event = receipt.logs
            .map(log => { try { return identity.interface.parseLog(log); } catch { return null; } })
            .find(e => e?.name === "Registered");

        const agentId = event?.args?.agentId ?? "?";
        const oracleNote = oracleAddr ? `oracle=${oracleAddr}` : "no oracle";
        console.log(`✓ ${file.padEnd(12)} agentId=${agentId}  owner=${owner.address}  ${oracleNote}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

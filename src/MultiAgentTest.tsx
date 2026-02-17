import { useState } from "react";
import { useWallet } from "@moveindustries/wallet-adapter-react";
import {
  Movement,
  MovementConfig,
  Network,
  AccountAddress,
  U64,
  Deserializer,
  Hex,
  AccountAuthenticator,
  MultiAgentTransaction,
} from "@moveindustries/ts-sdk";

export function MultiAgentTest() {
  const {
    connect,
    disconnect,
    account,
    connected,
    wallet,
    signTransaction,
    submitTransaction,
  } = useWallet();

  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Simulated "backend" storage
  const [serializedTransaction, setSerializedTransaction] = useState<string>("");
  const [secondSignerSignature, setSecondSignerSignature] = useState<string>("");
  const [secondSignerAddress, setSecondSignerAddress] = useState<string>("");

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const clearLogs = () => setLogs([]);

  // Load the compiled script
  const loadScript = async () => {
    log("Loading transfer_two_by_two.mv script...");
    const response = await fetch("/transfer_two_by_two.mv");
    const buffer = await response.arrayBuffer();
    const bytecode = new Uint8Array(buffer);
    log(`Script loaded: ${bytecode.length} bytes`);
    return bytecode;
  };

  // STEP 1: First sender creates the transaction (simulating backend)
  const step1_CreateTransaction = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    setLoading(true);
    clearLogs();

    try {
      log("=== STEP 1: Create Transaction (First Sender) ===");
      log(`First sender (you): ${account.address}`);

      const bytecode = await loadScript();

      const config = new MovementConfig({ network: Network.TESTNET });
      const movement = new Movement(config);

      // For this test, we'll use a placeholder for second signer
      // In real flow, this would be known ahead of time
      const secondSignerAddr = prompt("Enter second signer address (0x...):");
      if (!secondSignerAddr) {
        log("ERROR: Second signer address required");
        return;
      }
      setSecondSignerAddress(secondSignerAddr);

      const amountFirst = 1000;
      const amountSecond = 1000;
      const dstFirst = AccountAddress.from(account.address);
      const dstSecond = AccountAddress.from(secondSignerAddr);
      const depositFirst = 1000;

      log("Building multi-agent transaction (5 min expiration)...");
      const transaction = await movement.transaction.build.multiAgent({
        sender: AccountAddress.from(account.address),
        secondarySignerAddresses: [AccountAddress.from(secondSignerAddr)],
        data: {
          bytecode,
          functionArguments: [
            new U64(amountFirst),
            new U64(amountSecond),
            dstFirst,
            dstSecond,
            new U64(depositFirst),
          ],
        },
        options: {
          expireTimestamp: Math.floor(Date.now() / 1000) + 300, // 5 minutes from now
        },
      });

      // Serialize transaction (send to backend)
      const serializedTx = transaction.bcsToHex().toString();
      setSerializedTransaction(serializedTx);

      log("Transaction created and serialized");
      log(`Serialized TX: ${serializedTx.substring(0, 60)}...`);
      log("");
      log("Now switch wallet to second signer and click Step 2");

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);
    } finally {
      setLoading(false);
    }
  };

  // STEP 2: Second sender signs (using wallet adapter signTransaction)
  const step2_SecondSignerSign = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    if (!serializedTransaction) {
      log("ERROR: No transaction to sign. Run Step 1 first.");
      return;
    }

    setLoading(true);

    try {
      log("=== STEP 2: Second Sender Signs ===");
      log(`Current wallet: ${account.address}`);

      // Deserialize transaction (received from backend)
      const transaction = MultiAgentTransaction.deserialize(
        new Deserializer(Hex.fromHexString(serializedTransaction).toUint8Array())
      );
      log("Transaction deserialized");

      // Sign with wallet adapter's signTransaction
      log("Requesting wallet signature...");
      const signature = await signTransaction({
        transactionOrPayload: transaction,
      });
      log("Wallet signed successfully");

      // Serialize the authenticator (send to backend)
      const authenticatorBcsHex = signature.authenticator.bcsToHex().toString();
      const authenticatorBcs = authenticatorBcsHex.startsWith('0x')
        ? authenticatorBcsHex
        : '0x' + authenticatorBcsHex;

      setSecondSignerSignature(authenticatorBcs);

      log(`Serialized signature: ${authenticatorBcs.substring(0, 60)}...`);
      log("");
      log("Now switch wallet back to first signer and click Step 3");

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);
    } finally {
      setLoading(false);
    }
  };

  // STEP 3: First sender signs and submits (using wallet adapter submitTransaction)
  const step3_FirstSignerSubmit = async () => {
    if (!account) {
      log("ERROR: No account connected");
      return;
    }

    if (!serializedTransaction || !secondSignerSignature) {
      log("ERROR: Missing transaction or second signer signature. Complete Steps 1 and 2 first.");
      return;
    }

    setLoading(true);

    try {
      log("=== STEP 3: First Sender Signs & Submits ===");
      log(`Current wallet: ${account.address}`);

      // Deserialize transaction (from backend)
      const transaction = MultiAgentTransaction.deserialize(
        new Deserializer(Hex.fromHexString(serializedTransaction).toUint8Array())
      );
      log("Transaction deserialized");

      // Deserialize second signer's signature (from backend)
      const signatureHex = secondSignerSignature.startsWith('0x')
        ? secondSignerSignature.slice(2)
        : secondSignerSignature;

      const reviewerSignature = AccountAuthenticator.deserialize(
        new Deserializer(Hex.fromHexString(signatureHex).toUint8Array())
      );
      log("Reviewer signature deserialized");

      // First sender signs with wallet
      log("Requesting wallet signature...");
      const senderSignature = await signTransaction({
        transactionOrPayload: transaction,
      });
      log("Wallet signed successfully");

      // Submit using wallet adapter's submitTransaction (patched to handle Nightly's "custom" network)
      log("Submitting via wallet adapter submitTransaction...");
      const tx = await submitTransaction({
        transaction,
        senderAuthenticator: senderSignature.authenticator,
        additionalSignersAuthenticators: [reviewerSignature],
      });

      log(`SUCCESS! Transaction hash: ${tx.hash}`);

      // Wait for confirmation using SDK
      const config = new MovementConfig({ network: Network.TESTNET });
      const movement = new Movement(config);

      log("Waiting for confirmation...");
      const result = await movement.waitForTransaction({
        transactionHash: tx.hash,
      });
      log(`Transaction confirmed: ${result.success}`);

    } catch (error: any) {
      log(`ERROR: ${error.message || error}`);
      console.error("Full error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: "20px" }}>
        {!connected ? (
          <button onClick={() => connect("Nightly")} style={{ padding: "10px 20px" }}>
            Connect Wallet
          </button>
        ) : (
          <div>
            <p>Connected: {account?.address?.toString().slice(0, 10)}...</p>
            <p>Wallet: {wallet?.name}</p>
            <button onClick={disconnect} style={{ padding: "5px 10px" }}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {connected && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step1_CreateTransaction}
              disabled={loading}
              style={{ padding: "10px 20px", marginRight: "10px" }}
            >
              Step 1: Create TX (First Sender)
            </button>
          </div>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step2_SecondSignerSign}
              disabled={loading || !serializedTransaction}
              style={{ padding: "10px 20px", marginRight: "10px" }}
            >
              Step 2: Sign (Second Sender)
            </button>
          </div>
          <div style={{ marginBottom: "10px" }}>
            <button
              onClick={step3_FirstSignerSubmit}
              disabled={loading || !secondSignerSignature}
              style={{ padding: "10px 20px" }}
            >
              Step 3: Sign & Submit (First Sender)
            </button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: "10px", fontSize: "12px", color: "#888" }}>
        <p>Transaction: {serializedTransaction ? `${serializedTransaction.substring(0, 40)}...` : "(none)"}</p>
        <p>Second Signature: {secondSignerSignature ? `${secondSignerSignature.substring(0, 40)}...` : "(none)"}</p>
      </div>

      <div
        style={{
          background: "#1a1a1a",
          padding: "15px",
          borderRadius: "8px",
          maxHeight: "400px",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
          <strong>Logs:</strong>
          <button onClick={clearLogs} style={{ padding: "2px 8px", fontSize: "12px" }}>
            Clear
          </button>
        </div>
        {logs.length === 0 ? (
          <p style={{ color: "#666" }}>No logs yet. Connect wallet and run the steps.</p>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              style={{
                color: l.includes("ERROR") ? "#ff6b6b" : l.includes("SUCCESS") ? "#69db7c" : "#ccc",
                fontSize: "13px",
                marginBottom: "4px",
              }}
            >
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

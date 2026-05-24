const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const SwapService = require('./SwapService');
const EthereumWalletService = require('./wallets/EthereumWalletService');
const BitcoinWalletService = require('./wallets/BitcoinWalletService');
const SolanaWalletService = require('./wallets/SolanaWalletService');
const LitecoinWalletService = require('./wallets/LitecoinWalletService');
const PriceService = require('./PriceService');
const TransactionService = require('./TransactionService');
const SideshiftService = require('./SideshiftService');
class PayoutService {
  constructor() {
    this.swapService = SwapService;
    this.ethService = EthereumWalletService;
    this.btcService = BitcoinWalletService;
    this.solService = SolanaWalletService;
    this.ltcService = LitecoinWalletService;

    this.sideShift = new SideshiftService(this);
  }

  getWalletService(chain) {
    switch (chain.toUpperCase()) {
      case 'ETH': return this.ethService;
      case 'BTC': return this.btcService;
      case 'SOL': return this.solService;
      case 'LTC': return this.ltcService;
      default: throw new Error(`Unknown chain: ${chain}`);
    }
  }

  /**
   * Extract balance value from wallet service response
   * Each wallet service returns balance in a different property
   */
  getBalanceValue(chain, balanceResponse) {
    if (!balanceResponse || balanceResponse.status !== 'success') {
      return 0;
    }
    
    switch(chain.toUpperCase()) {
      case 'SOL': return parseFloat(balanceResponse.balanceSOL) || 0;
      case 'ETH': return parseFloat(balanceResponse.balanceEth) || 0;
      case 'BTC': return parseFloat(balanceResponse.balanceBTC) || 0;
      case 'LTC': return parseFloat(balanceResponse.balanceLTC) || 0;
      default: return 0;
    }
  }

  getClientActiveChains(clientId) {
    const wallets = db.findBy('wallets', { clientId, isActive: true });
    const chains = [...new Set(wallets.map(w => w.chain))];
    console.log(`[PayoutService] Client ${clientId} active chains: ${chains.join(', ')}`);
    return chains;
  }

  /**
   * Get withdrawal preview: Calculate withdrawal amounts without creating the payout
   * Used for showing user accurate data before they confirm
   * @param {string} clientId - Client ID
   * @param {string} recipientAddress - Ethereum address to receive funds
   * @param {Array} selectedChains - Chains to withdraw from
   * @returns {Promise<Object>} Preview data with eligible/ineligible wallets and gas fee calculations
   */
  async getWithdrawalPreview(clientId, recipientAddress, selectedChains) {
    console.log(`\n[PayoutService] Getting withdrawal preview for client: ${clientId}`);

    const client = db.findOneBy('users', { id: clientId });
    if (!client) {
      throw new Error(`Client with ID ${clientId} not found`);
    }

    if (!recipientAddress.startsWith('0x') || recipientAddress.length !== 42) {
      throw new Error('Invalid Ethereum address format');
    }

    // Get all wallets
    let allWallets = db.findBy('wallets', { clientId, isActive: true });
    if (!allWallets || allWallets.length === 0) {
      throw new Error('No active wallets found for this client');
    }

    const priceService = PriceService;

    // Fetch current balances from blockchain
    for (const wallet of allWallets) {
      try {
        const walletService = this.getWalletService(wallet.chain);
        const balanceResponse = await walletService.getBalance(wallet.address);
        const balanceValue = this.getBalanceValue(wallet.chain, balanceResponse);
        console.log(`[PayoutService] Fetched balance for ${wallet.chain} ${wallet.address}: ${balanceValue}`);
        wallet.balance = balanceValue;
      } catch (error) {
        console.warn(`[PayoutService] Could not fetch balance for ${wallet.chain} wallet ${wallet.address}:`, error.message);
      }
    }

    // Calculate USD values for each wallet
    allWallets.forEach(w => {
      let rate = 0;
      switch (w.chain.toUpperCase()) {
        case 'ETH': rate = priceService.ethToUsdRate; break;
        case 'BTC': rate = priceService.btcToUsdRate; break;
        case 'SOL': rate = priceService.solToUsdRate; break;
        case 'LTC': rate = priceService.ltcToUsdRate; break;
      }
      w.balanceUSD = (parseFloat(w.balance) || 0) * rate;
    });

    // Separate eligible and ineligible wallets
    const eligibleWallets = [];
    const ineligibleWallets = [];

    allWallets.forEach(w => {
      if (w.balanceUSD >= 5) {
        eligibleWallets.push(w);
      } else {
        ineligibleWallets.push(w);
      }
    });

    // Filter by selected chains if provided
    let selectedWallets = eligibleWallets;
    if (selectedChains && Array.isArray(selectedChains) && selectedChains.length > 0) {
      const selectedChainsUpper = selectedChains.map(c => c.toUpperCase());
      selectedWallets = eligibleWallets.filter(w => selectedChainsUpper.includes(w.chain.toUpperCase()));
    }

    if (selectedWallets.length === 0) {
      throw new Error('No eligible wallets selected for withdrawal');
    }

    // Calculate totals
    const totalAmountUsd = selectedWallets.reduce((sum, w) => sum + (w.balanceUSD || 0), 0);

    // Get withdrawal plan to calculate gas fees
    const plan = await this.swapService.planBatchWithdrawal(selectedWallets, totalAmountUsd);

    // Calculate gas fees per chain and total
    const gasPerChain = {};
    let totalGasUsd = 0;

    for (const transfer of plan.transfers) {
      const gasAmount = transfer.estimatedGas || 0;
      if (!gasPerChain[transfer.chain]) {
        gasPerChain[transfer.chain] = 0;
      }
      gasPerChain[transfer.chain] += gasAmount;
      totalGasUsd += gasAmount;
    }

    const platformFee = totalAmountUsd * 0.05;
    const netAmountUsd = totalAmountUsd - platformFee - totalGasUsd;

    return {
      clientId,
      recipientAddress,
      totalAmountUsd,
      platformFee,
      totalGasUsd,
      netAmountUsd,
      gasPerChain,
      selectedWallets: selectedWallets.map(w => ({
        chain: w.chain,
        address: w.address,
        balance: w.balance
      })),
      eligibleCount: eligibleWallets.length,
      ineligibleCount: ineligibleWallets.length,
      ineligibleWallets: ineligibleWallets.map(w => ({
        chain: w.chain,
        address: w.address,
        balance: w.balance,
        reason: 'Below $5 USD minimum (gas fees)'
      })),
      message: `You are withdrawing from ${selectedWallets.length} chain(s). Total: $${totalAmountUsd.toFixed(2)} USD`
    };
  }

  /**
   * Process withdrawal: Convert selected tokens to ETH and send to recipient
   * Only processes wallets >= $5 USD minimum
   * @param {string} clientId - Client ID
   * @param {string} recipientAddress - Ethereum address to receive funds
   * @param {Array} selectedChains - Chains to withdraw from (optional, defaults to all eligible)
   * @returns {Promise<Object>} Withdrawal payout with swap details
   */
  async processWithdrawal(clientId, recipientAddress, selectedChains) {
    console.log(`\n[PayoutService] Starting withdrawal process for client: ${clientId}`);

    const client = db.findOneBy('users', { id: clientId });
    if (!client) {
      console.error(`[PayoutService] Client not found: ${clientId}`);
      throw new Error(`Client with ID ${clientId} not found`);
    }

    // Validate ETH address
    if (!recipientAddress.startsWith('0x') || recipientAddress.length !== 42) {
      console.error(`[PayoutService] Invalid ETH address: ${recipientAddress}`);
      throw new Error('Invalid Ethereum address format');
    }


    // Get all wallets
    let wallets = db.findBy('wallets', { clientId, isActive: true });
    if (!wallets || wallets.length === 0) {
      console.error(`[PayoutService] No active wallets found for client: ${clientId}`);
      throw new Error('No active wallets found for this client');
    }

    // Filter by selected chains if provided
    if (selectedChains && Array.isArray(selectedChains) && selectedChains.length > 0) {
      const validChains = ['ETH', 'BTC', 'SOL', 'LTC'];
      const selectedChainsUpper = selectedChains.map(c => c.toUpperCase()).filter(c => validChains.includes(c));
      wallets = wallets.filter(w => selectedChainsUpper.includes(w.chain.toUpperCase()));
    }

    if (wallets.length === 0) {
      console.error(`[PayoutService] No wallets found for selected chains`);
      throw new Error('No wallets found for selected chains');
    }

    // Fetch current balances from blockchain
    for (const wallet of wallets) {
      try {
        const walletService = this.getWalletService(wallet.chain);
        const balanceResponse = await walletService.getBalance(wallet.address);
        const balanceValue = this.getBalanceValue(wallet.chain, balanceResponse);
        console.log(`[PayoutService] Fetched balance for ${wallet.chain} ${wallet.address}: ${balanceValue}`);
        wallet.balance = balanceValue;
      } catch (error) {
        console.warn(`[PayoutService] Could not fetch balance for ${wallet.chain} wallet ${wallet.address}:`, error.message);
      }
    }

    // Calculate USD values for each wallet using current prices
    const priceService = PriceService;

    wallets.forEach(w => {
      let rate = 0;
      switch (w.chain.toUpperCase()) {
        case 'ETH': rate = priceService.ethToUsdRate; break;
        case 'BTC': rate = priceService.btcToUsdRate; break;
        case 'SOL': rate = priceService.solToUsdRate; break;
        case 'LTC': rate = priceService.ltcToUsdRate; break;
      }

      w.balanceUSD = (parseFloat(w.balance) || 0) * rate;
    });

    // Filter wallets with >= $5 USD value
    const eligibleWallets = wallets.filter(w => {
      const balanceUSD = w.balanceUSD || 0;
      const isEligible = balanceUSD >= 5;
      console.log(`  - ${w.chain}: ${w.balance} (${w.address}) = $${balanceUSD.toFixed(2)} USD ${isEligible ? '✓' : 'SKIP (< $5)'}`);
      return isEligible;
    });

    if (eligibleWallets.length === 0) {
      console.error(`[PayoutService] No wallets with >= $5 USD value`);
      throw new Error('No eligible wallets for withdrawal - all wallets must have at least $5 USD value');
    }

    eligibleWallets.forEach(w => console.log(`  - ${w.chain}: $${(w.balanceUSD || 0).toFixed(2)}`))

    // Calculate total USD amount from eligible wallets
    let totalAmountUsd = eligibleWallets.reduce((sum, w) => sum + (w.balanceUSD || 0), 0);

    // Create withdrawal plan
    const plan = await this.swapService.planBatchWithdrawal(eligibleWallets, totalAmountUsd);

    // Calculate estimated total gas for the plan
    const estimatedTotalGas = plan.transfers.reduce((sum, t) => sum + (t.estimatedGas || 0), 0);

    // Calculate platform fee (5%)
    const platformFee = totalAmountUsd * 0.05;

    const netAmountUsd = totalAmountUsd - platformFee - estimatedTotalGas;
    console.log(`[PayoutService] Fee calculation: Total=$${totalAmountUsd.toFixed(2)}, Fee=$${platformFee.toFixed(2)}, Gas=${estimatedTotalGas.toFixed(2)}, Net=$${netAmountUsd.toFixed(2)}`);

    const payout = {
      id: uuidv4(),
      clientId,
      recipientAddress,
      netAmountUsd,
      platformFee,
      totalAmountUsd,
      chain: 'ETH',
      status: 'PENDING',
      type: 'WITHDRAWAL',
      withdrawalPlan: plan,
      transactionHashes: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
      estimatedTotalGas,
    };

    const self = this;
    payout.withdrawalPlan.transfers = await Promise.all(payout.withdrawalPlan.transfers.map(async (t) => {
      const swapDetails = await self.swapService.executeSwap({
        chain: t.chain,
        wallet: { address: t.fromAddress },
        recipientAddress
      });

      return {
        ...t,
        swapDetails
      };
    }));

    const createdPayout = db.create('payouts', payout);
    console.log(`[PayoutService] Payout created: ${createdPayout.id}`);

    // NOTE: Transactions are created in executeAndMonitorTransfers() when actually broadcasting
    // This avoids duplicate transaction records and ensures we track the actual broadcast time

    // Execute the actual transfers asynchronously (don't wait for completion)
    this.executeAndMonitorTransfers(createdPayout.id, payout.withdrawalPlan.transfers, recipientAddress)
      .catch(err => console.error(`[PayoutService] Error executing transfers for payout ${createdPayout.id}:`, err));

    return payout;
  }

  /**
   * Execute all transfers in a withdrawal plan and monitor their status
   * @param {string} payoutId - Payout ID
   * @param {Array} transfers - Transfers to execute
   * @param {string} recipientAddress - Final recipient ETH address
   */
  async executeAndMonitorTransfers(payoutId, transfers, recipientAddress) {
    console.log(`\n[PayoutService] Executing and monitoring ${transfers.length} transfer(s) for payout: ${payoutId}`);

    // Mark payout as PROCESSING
    this.updatePayoutStatus(payoutId, 'PROCESSING');

    const transactionIds = [];
    const broadcastedTransfers = [];

    // Step 1: Broadcast all transfers
    for (const transfer of transfers) {
      try {
        const sourceWallet = db.findOneBy('wallets', { address: transfer.fromAddress });
        if (!sourceWallet) {
          console.error(`[PayoutService] Source wallet not found: ${transfer.fromAddress}`);
          continue;
        }

        // Fetch current balance from blockchain before attempting transfer
        try {
          const walletService = this.getWalletService(transfer.chain);
          const balanceResponse = await walletService.getBalance(transfer.fromAddress);
          const currentBalance = this.getBalanceValue(transfer.chain, balanceResponse);
          console.log(`[PayoutService] Current balance on-chain: ${currentBalance} ${transfer.chain}`);
          
          if (parseFloat(currentBalance) < parseFloat(transfer.nativeAmount)) {
            console.error(`[PayoutService] ✗ Insufficient balance: Have ${currentBalance} ${transfer.chain}, need ${transfer.nativeAmount} ${transfer.chain}`);
            continue;
          }
        } catch (balanceError) {
          console.warn(`[PayoutService] Could not fetch current balance:`, balanceError.message);
          // Continue anyway, let the transfer attempt fail with proper error
        }

        console.log(`\n[PayoutService] Broadcasting ${transfer.chain} transfer: ${transfer.nativeAmount} ${transfer.chain}`);

        // Extract and validate deposit address
        const depositAddress = transfer.swapDetails?.sideshiftOrder?.depositAddress;
        if (!depositAddress) {
          console.error(`[PayoutService] ✗ No deposit address found for ${transfer.chain} transfer`);
          console.error(`[PayoutService]   swapDetails structure:`, JSON.stringify(transfer.swapDetails, null, 2));
          continue;
        }

        console.log(`[PayoutService] → Sending to deposit address: ${depositAddress}`);

        let txHash;
        try {
          if (transfer.chain === 'ETH') {
            // Direct ETH transfer
            const result = await this.sendEthereumTransfer(sourceWallet, depositAddress, transfer.nativeAmount);
            txHash = result.hash;
          } else if (transfer.chain === 'BTC') {
            // Bitcoin transfer to Sideshift deposit address
            txHash = await this.sendBitcoinTransfer(sourceWallet, depositAddress, transfer.nativeAmount);
          } else if (transfer.chain === 'SOL') {
            // Solana transfer
            txHash = await this.sendSolanaTransfer(sourceWallet, depositAddress, transfer.nativeAmount);
          } else if (transfer.chain === 'LTC') {
            // Litecoin transfer
            txHash = await this.sendLitecoinTransfer(sourceWallet, depositAddress, transfer.nativeAmount);
          }
        } catch (broadcastError) {
          const errorMsg = broadcastError.message;
          
          // Check for insufficient funds error
          if (errorMsg.includes('insufficient lamports') || 
              errorMsg.includes('insufficient funds') ||
              errorMsg.includes('insufficient balance')) {
            
            console.error(`[PayoutService] ✗ INSUFFICIENT FUNDS: ${transfer.chain} transfer failed`);
            
            // Create the transaction record
            const transaction = TransactionService.createTransaction(
              sourceWallet.clientId,
              'FAILED_BROADCAST',
              transfer.swapDetails.orderId,
              transfer.type,
              transfer.chain,
              transfer.nativeAmount,
              transfer.transactionValueUSD,
              transfer.fromAddress,
              depositAddress,
              recipientAddress
            );
            
            // Mark as FAILED immediately with reason
            TransactionService.markTransactionFailed(
              transaction.id,
              'INSUFFICIENT_FUNDS',
              `Not enough ${transfer.chain} to cover transfer amount + network fees`
            );
            
            // Still track it as a failed transaction
            transactionIds.push(transaction.id);
            console.log(`[PayoutService] Transaction marked FAILED: ${transaction.id} - Reason: INSUFFICIENT_FUNDS`);
          } else {
            console.error(`[PayoutService] Error broadcasting ${transfer.chain} transfer:`, errorMsg);
          }
          return;
        }

        if (!txHash) {
          console.error(`[PayoutService] Failed to get transaction hash for ${transfer.chain}`);
          continue;
        }

        // Create transaction record with PENDING status
        const transaction = TransactionService.createTransaction(
          sourceWallet.clientId,
          txHash,
          transfer.swapDetails.orderId,
          transfer.type,
          transfer.chain,
          transfer.nativeAmount,
          transfer.transactionValueUSD,
          transfer.fromAddress,
          depositAddress,
          recipientAddress
        );

        // Immediately mark as PROCESSING (broadcast confirmed)
        TransactionService.markTransactionProcessing(transaction.id, txHash);

        transactionIds.push(transaction.id);
        broadcastedTransfers.push({ ...transfer, txHash, transactionId: transaction.id });
        console.log(`[PayoutService] Transaction broadcasted: ${txHash} (${transaction.id}) - Status: PROCESSING`);
      } catch (error) {
        console.error(`[PayoutService] Error broadcasting ${transfer.chain} transfer:`, error.message);
      }
    }

    // Step 2: Monitor transactions until confirmed
    const { confirmedCount, failedCount } = await this.monitorTransactionConfirmation(transactionIds, broadcastedTransfers);

    // Step 3: Determine payout final status based on transaction results
    let finalStatus = 'COMPLETED';
    if (failedCount > 0 && confirmedCount > 0) {
      finalStatus = 'PARTIAL'; // Some succeeded, some failed
    } else if (failedCount > 0 && confirmedCount === 0) {
      finalStatus = 'FAILED'; // All failed
    }

    console.log(`[PayoutService] All transactions completed for payout ${payoutId} - Status: ${finalStatus}`);
    this.updatePayoutStatus(payoutId, finalStatus);
  }

  /**
   * Send Ethereum transfer using EthereumWalletService with EIP-1559 support
   */
  async sendEthereumTransfer(wallet, toAddress, amount) {
    try {
      // Use EthereumWalletService with proper EIP-1559 fees
      const result = await this.ethService.sendTransaction(
        wallet.privateKey,
        toAddress,
        amount,
        'transfer'
      );

      console.log(`[PayoutService] Ethereum transaction sent: ${result.hash}`);
      console.log(`  Max Fee: ${result.maxFeePerGasGwei} GWEI | Priority: ${result.maxPriorityFeePerGasGwei} GWEI`);
      
      return {
        hash: result.hash,
        fee: {
          maxFeePerGasGwei: result.maxFeePerGasGwei,
          maxPriorityFeePerGasGwei: result.maxPriorityFeePerGasGwei,
          gasLimit: result.gasLimit
        }
      };
    } catch (error) {
      console.error(`[PayoutService] Ethereum transfer failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send Bitcoin transfer to Sideshift deposit address
   */
  async sendBitcoinTransfer(wallet, toAddress, amount) {
    try {
      // For Bitcoin, we send to Sideshift's deposit address
      const txHash = await this.btcService.sendTransaction(wallet.privateKey, toAddress, amount);
      console.log(`[PayoutService] Bitcoin transaction sent: ${txHash}`);
      return txHash;
    } catch (error) {
      console.error(`[PayoutService] Bitcoin transfer failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send Solana transfer to Sideshift deposit address
   */
  async sendSolanaTransfer(wallet, toAddress, amount) {
    try {
      const txHash = await this.solService.sendTransaction(wallet.privateKey, toAddress, amount);
      console.log(`[PayoutService] Solana transaction sent: ${txHash}`);
      return txHash;
    } catch (error) {
      console.error(`[PayoutService] Solana transfer failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send Litecoin transfer to Sideshift deposit address
   */
  async sendLitecoinTransfer(wallet, toAddress, amount) {
    try {
      const txHash = await this.ltcService.sendTransaction(wallet.privateKey, toAddress, amount);
      console.log(`[PayoutService] Litecoin transaction sent: ${txHash}`);
      return txHash;
    } catch (error) {
      console.error(`[PayoutService] Litecoin transfer failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Monitor transactions until confirmed or failed using Sideshift order status
   * Instead of polling RPC endpoints, we check if the Sideshift order is completed
   * @returns {Object} { confirmedCount, failedCount } - Number of confirmed and failed transactions
   */
  async monitorTransactionConfirmation(transactionIds, transfers) {
    console.log(`\n[PayoutService] Monitoring ${transactionIds.length} transaction(s) via Sideshift...`);

    const maxAttempts = 120; // 10 minutes with 5 second intervals
    let attempts = 0;
    const confirmedTxs = new Set();
    const failedTxs = new Set();

    while ((confirmedTxs.size + failedTxs.size) < transactionIds.length && attempts < maxAttempts) {
      for (const transfer of transfers) {
        if (confirmedTxs.has(transfer.transactionId) || failedTxs.has(transfer.transactionId)) {
          continue;
        }

        try {
          let isConfirmed = false;
          let isFailed = false;
          let failureReason = null;

          // Get Sideshift order status using orderId (and txHash for direct transfers)
          const orderId = transfer.swapDetails?.orderId;
          const txHash = transfer.txHash;
          if (!orderId) {
            console.error(`[PayoutService] No orderId found for transfer ${transfer.transactionId}`);
            isFailed = true;
            failureReason = 'MISSING_ORDER_ID';
          } else {
            try {
              const orderResponse = await this.sideShift.getOrderStatus(orderId, txHash);
              const orderStatus = orderResponse[0]; // Sideshift API returns an array of orders

              console.log(`[PayoutService] Order ${orderId} status: ${orderStatus.status}`);

              // Check order status
              if (orderStatus.status === 'settled') {
                // Order completed successfully
                isConfirmed = true;
                console.log(`[PayoutService] ✓ Order completed: ${orderId}`);
              } else if (orderStatus.status === 'expired') {
                // Order expired
                isFailed = true;
                failureReason = 'ORDER_EXPIRED';
                console.log(`[PayoutService] ✗ Order expired: ${orderId}`);
              } else if (orderStatus.status === 'failed') {
                // Order failed
                isFailed = true;
                failureReason = 'ORDER_FAILED';
                console.log(`[PayoutService] ✗ Order failed: ${orderId} - ${orderStatus.failureReason || 'unknown reason'}`);
              } else if (orderStatus.status === 'refunded') {
                // Order refunded
                isFailed = true;
                failureReason = 'ORDER_REFUNDED';
                console.log(`[PayoutService] ✗ Order refunded: ${orderId}`);
              } else if (orderStatus.status === 'waiting') {
                // Order is waiting for funds, continue monitoring
                console.log(`[PayoutService] ⏳ Order waiting for funds: ${orderId}`);
              };
            } catch (orderError) {
              console.warn(`[PayoutService] Error fetching order status for ${orderId}: ${orderError.message}`);
              // Continue monitoring on error, don't mark as failed
            }
          }

          // Update status based on confirmation or failure
          if (isFailed) {
            TransactionService.markTransactionFailed(
              transfer.transactionId,
              failureReason || 'UNKNOWN_ERROR',
              `Sideshift order ${orderId} failed or expired`
            );
            failedTxs.add(transfer.transactionId);
            console.log(`[PayoutService] ✗ FAILED: Order ${orderId} (${failureReason})`);
          } else if (isConfirmed) {
            TransactionService.updateTransactionStatus(transfer.transactionId, 'CONFIRMED', null);
            confirmedTxs.add(transfer.transactionId);
            console.log(`[PayoutService] ✓ CONFIRMED: Order ${orderId} completed`);
          }
        } catch (error) {
          console.error(`[PayoutService] Error monitoring transaction: ${error.message}`);
          // Don't mark as failed for RPC errors, try again next iteration
        }
      }

      // If still pending, wait and try again
      if ((confirmedTxs.size + failedTxs.size) < transactionIds.length) {
        const remaining = transactionIds.length - confirmedTxs.size - failedTxs.size;
        console.log(`[PayoutService] Waiting... (${confirmedTxs.size} confirmed, ${failedTxs.size} failed, ${remaining} PROCESSING)`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        attempts++;
      }
    }

    // Handle timeout - mark remaining as FAILED
    if ((confirmedTxs.size + failedTxs.size) < transactionIds.length) {
      for (const transfer of transfers) {
        if (!confirmedTxs.has(transfer.transactionId) && !failedTxs.has(transfer.transactionId)) {
          TransactionService.markTransactionFailed(
            transfer.transactionId,
            'TIMEOUT',
            `Order not confirmed within ${maxAttempts * 5} seconds`
          );
          console.warn(`[PayoutService] ✗ TIMEOUT: Order ${transfer.swapDetails?.orderId}`);
        }
      }
      console.warn(`[PayoutService] Monitoring complete: ${confirmedTxs.size} confirmed, ${failedTxs.size} failed, ${transactionIds.length - confirmedTxs.size - failedTxs.size} timeout`);
    } else {
      console.log(`[PayoutService] ✓ All transactions processed: ${confirmedTxs.size} confirmed, ${failedTxs.size} failed!`);
    }

    return {
      confirmedCount: confirmedTxs.size,
      failedCount: failedTxs.size
    };
  }

  /**
   * Get a specific payout
   */
  getPayout(payoutId) {
    return db.getById('payouts', payoutId);
  }

  /**
   * Get all payouts for a client
   */
  getClientPayouts(clientId) {
    return db.findBy('payouts', { clientId });
  }

  /**
   * Get payouts by status
   */
  getPayoutsByStatus(status) {
    return db.findBy('payouts', { status: status.toUpperCase() });
  }

  /**
   * Update payout status
   */
  updatePayoutStatus(payoutId, status) {
    const updates = {
      status,
      updatedAt: new Date().toISOString(),
    };
    
    if (status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED') {
      updates.completedAt = new Date().toISOString();
    }

    const payout = db.update('payouts', payoutId, updates);
    if (!payout) {
      throw new Error(`Payout with ID ${payoutId} not found`);
    }
    
    console.log(`[PayoutService] Updated payout ${payoutId}: status=${status}, completedAt=${updates.completedAt || 'null'}`);
    
    return payout;
  }
}

module.exports = new PayoutService();

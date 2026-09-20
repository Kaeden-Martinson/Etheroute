const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const SwapService = require('./SwapService');
const { walletServiceFor, balanceKeyFor } = require('./wallets');
const chains = require('../config/chains');
const PriceService = require('./PriceService');
const TransactionService = require('./TransactionService');
const SideshiftService = require('./SideshiftService');
const KeyVault = require('./crypto/KeyVault');
const { config } = require('../config/env');
const { validateChain, validateCryptoAddress } = require('../utils/validators');
const { ApiError, ValidationError } = require('../utils/errors');
const GasEstimator = require('./GasEstimator');

class PayoutService {
  constructor() {
    this.swapService = SwapService;

    this.sideShift = new SideshiftService(this);

    // Clients with a withdrawal currently being planned. Two requests that
    // arrive together would each read the same balances, each see no in-flight
    // transaction (those are only recorded at broadcast) and each try to sweep
    // the same wallets. The second broadcast would fail on-chain, but not
    // before a second payout record and a second set of Sideshift orders had
    // been created.
    this.inFlightClients = new Set();
  }

  /**
   * Wallets already committed to a payout that has not finished. Checked in
   * addition to the transaction table because a payout exists before any of
   * its transfers has been broadcast.
   */
  addressesInFlight(clientId) {
    const busy = new Set();
    for (const payout of db.findBy('payouts', { clientId })) {
      if (!['PENDING', 'PROCESSING'].includes(payout.status)) continue;
      for (const transfer of (payout.withdrawalPlan && payout.withdrawalPlan.transfers) || []) {
        if (['PENDING', 'PROCESSING'].includes(transfer.status)) busy.add(transfer.fromAddress);
      }
    }
    return busy;
  }

  getWalletService(chain) {
    return walletServiceFor(chain);
  }

  /**
   * Extract balance value from wallet service response
   * Each wallet service returns balance in a different property
   */
  getBalanceValue(chain, balanceResponse) {
    if (!balanceResponse || balanceResponse.status !== 'success') {
      return 0;
    }
    if (!chains.has(chain)) return 0;
    return parseFloat(balanceResponse[balanceKeyFor(chain)]) || 0;
  }

  getClientActiveChains(clientId) {
    const wallets = db.findBy('wallets', { clientId, isActive: true });
    const chains = [...new Set(wallets.map(w => w.chain))];
    console.log(`[PayoutService] Client ${clientId} active chains: ${chains.join(', ')}`);
    return chains;
  }

  getClientActiveWalletAddresses(clientId) {
    const wallets = db.findBy('wallets', { clientId, isActive: true });
    const addresses = wallets.map(w => w.address);
    console.log(`[PayoutService] Client ${clientId} active wallet addresses: ${addresses.join(', ')}`);
    return addresses;
  }

  /**
   * Get withdrawal preview: Calculate withdrawal amounts without creating the payout
   * Used for showing user accurate data before they confirm
   * @param {string} clientId - Client ID
   * @param {string} recipientAddress - Address to receive funds, on payoutChain
   * @param {Array} selectedWalletAddresses - Wallet addresses to withdraw from (optional, defaults to all active)
   * @param {string} payoutChain - Chain to cash out in: ETH, BTC, LTC or SOL
   * @returns {Promise<Object>} Preview data with eligible/ineligible wallets and gas fee calculations
   */
  async getWithdrawalPreview(clientId, recipientAddress, selectedWalletAddresses, payoutChain = 'ETH') {
    console.log(`\n[PayoutService] Getting withdrawal preview for client: ${clientId}`);

    const client = db.findOneBy('users', { id: clientId });
    if (!client) {
      throw new ApiError(404, 'Client not found');
    }

    if (!validateChain(payoutChain)) {
      throw new ValidationError(`Unsupported payout chain: ${payoutChain}`);
    }
    if (!validateCryptoAddress(recipientAddress, payoutChain)) {
      throw new ValidationError(`Invalid ${payoutChain} address format`);
    }

    // Get all wallets
    let allWallets = db.findBy('wallets', { clientId, isActive: true });
    if (!allWallets || allWallets.length === 0) {
      throw new ValidationError('You have no active wallets to withdraw from. Create one first.');
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
      w.balanceUSD = (parseFloat(w.balance) || 0) * priceService.rateFor(w.chain);
    });

    // Separate eligible and ineligible wallets
    // A wallet is eligible if its net payout clears the platform fee plus gas,
    // and - when a swap is involved - SideShift's $5 minimum. A same-chain
    // payout skips the swap, so it only has to cover the network fee.
    // It must also have no currently-processing transactions.
    // Live network costs, fetched once and shared by eligibility and planning
    // so the two cannot disagree.
    const gasByChain = await GasEstimator.estimateMany(allWallets.map(w => w.chain));

    const eligibleWallets = [];
    const ineligibleWallets = [];

    allWallets.forEach(w => {
      // Reject wallets with an active (PENDING or PROCESSING) transaction
      const walletTxs = db.findBy('transactions', { fromAddress: w.address });
      const hasActiveTx = walletTxs.some(t => t.status === 'PENDING' || t.status === 'PROCESSING');
      if (hasActiveTx) {
        ineligibleWallets.push({ ...w, ineligibilityReason: 'Transaction currently processing' });
        return;
      }

      const minBalanceUSD = this.swapService.minimumBalanceUsd(
        w.chain.toUpperCase(), payoutChain, config.payouts.platformFeeRate,
        (gasByChain[w.chain.toUpperCase()] || {}).usd
      );
      if (w.balanceUSD >= minBalanceUSD) {
        eligibleWallets.push(w);
      } else {
        const isDirect = w.chain.toUpperCase() === payoutChain;
        ineligibleWallets.push({
          ...w,
          ineligibilityReason: isDirect
            ? `Balance too small to cover the ${w.chain} network fee (needs about $${minBalanceUSD.toFixed(2)})`
            : `Needs about $${minBalanceUSD.toFixed(2)} to clear the $5 swap minimum plus fees. Cashing out in ${w.chain} instead avoids the swap.`,
        });
      }
    });

    // Filter by selected wallet addresses if provided
    const hasExplicitSelection = Array.isArray(selectedWalletAddresses) && selectedWalletAddresses.length > 0;
    let selectedWallets = eligibleWallets;
    if (hasExplicitSelection) {
      selectedWallets = eligibleWallets.filter(w => selectedWalletAddresses.includes(w.address));
    }

    if (selectedWallets.length === 0) {
      // Say "selected" only when the caller actually chose wallets - otherwise
      // it reads as though they picked something they did not.
      const subject = hasExplicitSelection ? 'None of the selected wallets have' : 'No wallet has';
      const alternative = payoutChain === 'ETH'
        ? 'Cashing out in a chain you already hold avoids the swap and its $5 minimum.'
        : `A wallet already on ${payoutChain} would be sent directly, with no swap and no $5 minimum.`;

      throw new ValidationError(`${subject} enough balance to cash out in ${payoutChain} after fees. ${alternative}`);
    }

    // Calculate totals
    const totalAmountUsd = selectedWallets.reduce((sum, w) => sum + (w.balanceUSD || 0), 0);

    // Get withdrawal plan to calculate gas fees
    const plan = await this.swapService.planBatchWithdrawal(selectedWallets, totalAmountUsd, payoutChain);

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

    // Take the fee from the plan rather than recomputing it from the raw
    // balance. The plan is what actually gets broadcast, so deriving the quote
    // from anything else lets the two drift - which is exactly how the quoted
    // net came to differ from the amount really sent.
    const platformFee = plan.transfers.reduce((sum, t) => sum + (t.platformFeeUSD || 0), 0);
    const grossSweptUsd = plan.transfers.reduce((sum, t) => sum + (t.walletValueUSD || 0), 0);
    const netAmountUsd = grossSweptUsd - platformFee - totalGasUsd;

    return {
      clientId,
      recipientAddress,
      payoutChain,
      totalAmountUsd,
      // What is actually swept, after the network fee is reserved. Slightly
      // below the raw balance, and the figure the fee is charged on.
      grossSweptUsd,
      platformFee,
      totalGasUsd,
      netAmountUsd,
      gasPerChain,
      platformFeeRate: config.payouts.platformFeeRate,
      // One line per transfer, straight from the plan. The dashboard renders
      // these as-is - it used to recompute the fee from the raw balance and
      // fall back to a made-up gas figure when the real one was missing, so
      // the per-chain lines and the totals disagreed on the same screen.
      transfers: plan.transfers.map(t => ({
        chain: t.chain,
        payoutChain: t.payoutChain,
        type: t.type,
        fromAddress: t.fromAddress,
        grossUsd: t.walletValueUSD || 0,
        platformFeeUsd: t.platformFeeUSD || 0,
        gasUsd: t.estimatedGas || 0,
        netUsd: (t.walletValueUSD || 0) - (t.platformFeeUSD || 0) - (t.estimatedGas || 0),
        nativeAmount: t.nativeAmount,
        expectedOutputAmount: t.expectedOutputAmount,
        gasIsLive: t.gasIsLive !== false,
      })),
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
        reason: w.ineligibilityReason || 'Balance too small to cover fees for this payout chain',
      })),
      message: `You are withdrawing from ${selectedWallets.length} wallet(s) and receiving ${payoutChain}. Total: $${totalAmountUsd.toFixed(2)} USD`
    };
  }

  /**
   * Process withdrawal: convert the selected wallets into payoutChain and send
   * to the recipient. Wallets already on payoutChain are sent directly, with no
   * swap and no swap minimum.
   * @param {string} clientId - Client ID
   * @param {string} recipientAddress - Address to receive funds, on payoutChain
   * @param {Array} selectedWalletAddresses - Wallet addresses to withdraw from (optional, defaults to all eligible)
   * @returns {Promise<Object>} Withdrawal payout with swap details
   */
  async processWithdrawal(clientId, recipientAddress, selectedWalletAddresses, payoutChain = 'ETH') {
    if (this.inFlightClients.has(clientId)) {
      throw new ApiError(409, 'A withdrawal is already being processed for this account. Wait for it to finish before starting another.');
    }

    this.inFlightClients.add(clientId);
    try {
      return await this._processWithdrawal(clientId, recipientAddress, selectedWalletAddresses, payoutChain);
    } finally {
      this.inFlightClients.delete(clientId);
    }
  }

  async _processWithdrawal(clientId, recipientAddress, selectedWalletAddresses, payoutChain = 'ETH') {
    console.log(`\n[PayoutService] Starting withdrawal process for client: ${clientId}`);

    const client = db.findOneBy('users', { id: clientId });
    if (!client) {
      console.error(`[PayoutService] Client not found: ${clientId}`);
      throw new ApiError(404, 'Client not found');
    }

    if (!validateChain(payoutChain)) {
      throw new ValidationError(`Unsupported payout chain: ${payoutChain}`);
    }
    if (!validateCryptoAddress(recipientAddress, payoutChain)) {
      console.error(`[PayoutService] Invalid ${payoutChain} address: ${recipientAddress}`);
      throw new ValidationError(`Invalid ${payoutChain} address format`);
    }


    // Get all wallets
    let wallets = db.findBy('wallets', { clientId, isActive: true });
    if (!wallets || wallets.length === 0) {
      console.error(`[PayoutService] No active wallets found for client: ${clientId}`);
      throw new ValidationError('You have no active wallets to withdraw from. Create one first.');
    }

    // Filter by selected wallet addresses if provided
    if (selectedWalletAddresses && Array.isArray(selectedWalletAddresses) && selectedWalletAddresses.length > 0) {
      wallets = wallets.filter(w => selectedWalletAddresses.includes(w.address));
    }

    if (wallets.length === 0) {
      console.error(`[PayoutService] No wallets found for selected wallet addresses`);
      throw new ValidationError('None of the selected wallets belong to your account.');
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
      w.balanceUSD = (parseFloat(w.balance) || 0) * priceService.rateFor(w.chain);
    });

    // Same eligibility rule as the preview, so what was shown is what runs.
    // Also skip wallets that have an active (PENDING or PROCESSING) transaction
    const gasByChain = await GasEstimator.estimateMany(wallets.map(w => w.chain));

    const busyAddresses = this.addressesInFlight(clientId);

    const eligibleWallets = wallets.filter(w => {
      // Check for active transactions first
      const walletTxs = db.findBy('transactions', { fromAddress: w.address });
      const hasActiveTx = busyAddresses.has(w.address) ||
        walletTxs.some(t => t.status === 'PENDING' || t.status === 'PROCESSING');
      if (hasActiveTx) {
        console.log(`  - ${w.chain}: ${w.address} SKIP (transaction currently processing)`);
        return false;
      }

      const balanceUSD = w.balanceUSD || 0;
      const minBalanceUSD = this.swapService.minimumBalanceUsd(
        w.chain.toUpperCase(), payoutChain, config.payouts.platformFeeRate,
        (gasByChain[w.chain.toUpperCase()] || {}).usd
      );
      const isEligible = balanceUSD >= minBalanceUSD;
      console.log(`  - ${w.chain}: ${w.balance} (${w.address}) = $${balanceUSD.toFixed(2)} USD ${isEligible ? '✓' : `SKIP (need $${minBalanceUSD.toFixed(2)} for net $5 after fee+gas)`}`);
      return isEligible;
    });

    if (eligibleWallets.length === 0) {
      console.error(`[PayoutService] No wallets with sufficient balance for net $5 after fee and gas`);
      throw new ValidationError(`No wallet has enough balance to cash out in ${payoutChain} after fees. Cashing out in a chain you already hold avoids the swap and its $5 minimum.`);
    }

    eligibleWallets.forEach(w => console.log(`  - ${w.chain}: $${(w.balanceUSD || 0).toFixed(2)}`))

    // Calculate total USD amount from eligible wallets
    let totalAmountUsd = eligibleWallets.reduce((sum, w) => sum + (w.balanceUSD || 0), 0);

    // Create withdrawal plan
    const plan = await this.swapService.planBatchWithdrawal(eligibleWallets, totalAmountUsd, payoutChain);

    // Calculate estimated total gas for the plan
    const estimatedTotalGas = plan.transfers.reduce((sum, t) => sum + (t.estimatedGas || 0), 0);

    // Calculate platform fee (5%)
    const platformFee = plan.transfers.reduce((sum, t) => sum + (t.platformFeeUSD || 0), 0);
    const grossSweptUsd = plan.transfers.reduce((sum, t) => sum + (t.walletValueUSD || 0), 0);

    const netAmountUsd = grossSweptUsd - platformFee - estimatedTotalGas;
    console.log(`[PayoutService] Fee calculation: Total=$${totalAmountUsd.toFixed(2)}, Fee=$${platformFee.toFixed(2)}, Gas=${estimatedTotalGas.toFixed(2)}, Net=$${netAmountUsd.toFixed(2)}`);

    const payout = {
      id: uuidv4(),
      clientId,
      recipientAddress,
      netAmountUsd,
      platformFee,
      totalAmountUsd,
      grossSweptUsd,
      chain: payoutChain,
      payoutChain,
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
        recipientAddress,
        payoutChain,
        nativeAmount: t.nativeAmount,
      });

      const order = swapDetails.sideshiftOrder || {};
      if (order.type === 'fixed' && order.depositAmount) {
        // The shift settles exactly this deposit at exactly this rate. Make
        // the plan say so, so what is recorded, sent and shown all agree.
        const payoutRate = PriceService[`${payoutChain.toLowerCase()}ToUsdRate`] || 0;
        return {
          ...t,
          nativeAmount: Number(order.depositAmount),
          expectedOutputAmount: Number(order.settleAmount),
          transactionValueUSD: Number(order.settleAmount) * payoutRate,
          rateLocked: true,
          rateExpiresAt: order.expiresAt,
          swapDetails,
        };
      }

      return {
        ...t,
        rateLocked: false,
        swapDetails
      };
    }));

    const createdPayout = db.create('payouts', payout);
    console.log(`[PayoutService] Payout created: ${createdPayout.id}`);

    // The platform fee is recorded against each wallet when its transfer is
    // actually broadcast - see executeAndMonitorTransfers. Recording it here,
    // for every wallet in the plan, meant a transfer that never left the
    // wallet still had a fee deducted from the client's displayed balance.

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

    // A transfer that is skipped before broadcast is a failed transfer. It
    // used to be silently dropped, which left it PENDING in the plan and, when
    // every transfer was skipped, produced a payout marked COMPLETED with
    // nothing sent.
    const skip = (transfer, reason, detail) => {
      console.error(`[PayoutService] ✗ ${transfer.chain} transfer skipped (${reason}): ${detail}`);
      this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
        status: 'FAILED',
        failureReason: reason,
        failureDetail: detail,
      });
    };

    // Step 1: Broadcast all transfers
    for (const transfer of transfers) {
      try {
        const storedWallet = db.findOneBy('wallets', { address: transfer.fromAddress });
        // Signing keys are encrypted at rest; decrypt into a local that never
        // leaves this scope and is never written back to the database.
        const sourceWallet = KeyVault.unsealWallet(storedWallet);
        if (!sourceWallet) {
          skip(transfer, 'WALLET_NOT_FOUND', `Source wallet not found: ${transfer.fromAddress}`);
          continue;
        }

        // Fetch current balance from blockchain before attempting transfer
        try {
          const walletService = this.getWalletService(transfer.chain);
          const balanceResponse = await walletService.getBalance(transfer.fromAddress);
          const currentBalance = this.getBalanceValue(transfer.chain, balanceResponse);
          console.log(`[PayoutService] Current balance on-chain: ${currentBalance} ${transfer.chain}`);
          
          if (parseFloat(currentBalance) < parseFloat(transfer.nativeAmount)) {
            skip(transfer, 'INSUFFICIENT_FUNDS', `Have ${currentBalance} ${transfer.chain}, need ${transfer.nativeAmount} ${transfer.chain}`);
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
          console.error(`[PayoutService]   swapDetails structure:`, JSON.stringify(transfer.swapDetails, null, 2));
          skip(transfer, 'NO_DEPOSIT_ADDRESS', 'The swap order carried no deposit address');
          continue;
        }

        console.log(`[PayoutService] → Sending to deposit address: ${depositAddress}`);

        // A fixed-rate shift settles only a deposit of exactly the quoted
        // amount, and only inside its window. Send Sideshift's own string so
        // no float rounding creeps in, and never broadcast into a shift that
        // has already expired - that deposit would sit in review.
        const order = transfer.swapDetails?.sideshiftOrder || {};
        const isFixed = order.type === 'fixed' && order.depositAmount;
        const sendAmount = isFixed ? order.depositAmount : transfer.nativeAmount;

        if (isFixed && order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
          skip(transfer, 'QUOTE_EXPIRED', `Fixed-rate shift ${transfer.swapDetails.orderId} expired at ${order.expiresAt} before broadcast`);
          continue;
        }

        let txHash;
        try {
          txHash = await this.sendTransfer(transfer.chain, sourceWallet, depositAddress, sendAmount);
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

            this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
              transactionId: transaction.id,
              status: 'FAILED',
              failureReason: 'INSUFFICIENT_FUNDS',
            });

            // Still track it as a failed transaction
            transactionIds.push(transaction.id);
            console.log(`[PayoutService] Transaction marked FAILED: ${transaction.id} - Reason: INSUFFICIENT_FUNDS`);
          } else {
            console.error(`[PayoutService] Error broadcasting ${transfer.chain} transfer:`, errorMsg);

            // Record the failure so the transfer does not sit in limbo and keep
            // the source wallet locked out of future withdrawals.
            try {
              const transaction = TransactionService.createTransaction(
                sourceWallet.clientId,
                'FAILED_BROADCAST',
                transfer.swapDetails?.orderId,
                transfer.type,
                transfer.chain,
                transfer.nativeAmount,
                transfer.transactionValueUSD,
                transfer.fromAddress,
                depositAddress,
                recipientAddress
              );
              TransactionService.markTransactionFailed(transaction.id, 'BROADCAST_FAILED', errorMsg);
              this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
                transactionId: transaction.id,
                status: 'FAILED',
                failureReason: 'BROADCAST_FAILED',
              });
            } catch (recordError) {
              console.error(`[PayoutService] Could not record broadcast failure:`, recordError.message);
            }
          }

          // Move on to the next transfer. Returning here abandoned every
          // remaining chain and left the payout stuck in PROCESSING forever.
          continue;
        }

        if (!txHash) {
          skip(transfer, 'NO_TX_HASH', 'The wallet service returned no transaction hash');
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

        this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
          transactionId: transaction.id,
          status: 'PROCESSING',
          txHash,
        });

        transactionIds.push(transaction.id);
        broadcastedTransfers.push({ ...transfer, txHash, transactionId: transaction.id });
        console.log(`[PayoutService] Transaction broadcasted: ${txHash} (${transaction.id}) - Status: PROCESSING`);

        // The funds have left; the platform fee is what stayed behind.
        this._recordServiceFee(storedWallet, transfer);
      } catch (error) {
        console.error(`[PayoutService] Error broadcasting ${transfer.chain} transfer:`, error.message);
        skip(transfer, 'BROADCAST_ERROR', error.message);
      }
    }

    // Step 2: Monitor transactions until confirmed.
    // Only broadcast transfers can be monitored - transactionIds also holds
    // records for transfers that failed before broadcast, and counting those
    // made the completion condition unreachable, so monitoring always ran to
    // its full timeout.
    const monitoredIds = broadcastedTransfers.map((transfer) => transfer.transactionId);
    const { confirmedCount, failedCount, unresolvedCount } = await this.monitorTransactionConfirmation(payoutId, monitoredIds, broadcastedTransfers);

    // Every transfer in the plan that was not broadcast is a failure, whether
    // or not a transaction record was written for it.
    const preBroadcastFailures = transfers.length - broadcastedTransfers.length;

    if (unresolvedCount > 0) {
      // Still in flight after the in-process watch window. Leave the payout
      // PROCESSING; the maintenance sweep keeps checking the chain and settles
      // it when the transfers land. Calling it FAILED here, as this used to,
      // reported a slow Bitcoin confirmation as lost money.
      console.log(`[PayoutService] Payout ${payoutId} still has ${unresolvedCount} transfer(s) in flight - handed to the maintenance sweep`);
      return;
    }

    this.finalisePayout(payoutId, confirmedCount, failedCount + preBroadcastFailures);
  }

  /**
   * Set a payout's terminal status from its transfer outcomes.
   */
  finalisePayout(payoutId, confirmedCount, failedCount) {
    let finalStatus = 'COMPLETED';
    if (failedCount > 0 && confirmedCount > 0) {
      finalStatus = 'PARTIAL'; // Some succeeded, some failed
    } else if (failedCount > 0 && confirmedCount === 0) {
      finalStatus = 'FAILED'; // All failed
    }

    console.log(`[PayoutService] All transactions completed for payout ${payoutId} - Status: ${finalStatus}`);
    this.updatePayoutStatus(payoutId, finalStatus);
    return finalStatus;
  }

  /**
   * Broadcast a transfer from a wallet on `chain`. Every family's service
   * takes (privateKey, to, amount) and returns a hash - directly, or in
   * `{ hash }` for the EVM family.
   */
  async sendTransfer(chain, wallet, toAddress, amount) {
    const service = walletServiceFor(chain);
    const result = await service.sendTransaction(wallet.privateKey, toAddress, amount);
    const hash = result && typeof result === 'object' ? result.hash : result;
    if (!hash) throw new Error(`${chain} transfer returned no transaction hash`);
    return hash;
  }

  async monitorTransactionConfirmation(payoutId, transactionIds, transfers) {
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
              const orderResponse = await this.sideShift.getOrderStatus(orderId, txHash, transfer.chain);
              const orderStatus = orderResponse[0]; // Sideshift API returns an array of orders

              console.log(`[PayoutService] Order ${orderId} status: ${orderStatus.status}`);

              const outcome = PayoutService.classifyOrderStatus(orderStatus.status);
              if (outcome.confirmed) {
                isConfirmed = true;
                console.log(`[PayoutService] ✓ Order completed: ${orderId}`);
              } else if (outcome.failed) {
                isFailed = true;
                failureReason = outcome.reason;
                console.log(`[PayoutService] ✗ Order ${orderStatus.status}: ${orderId}`);
              } else {
                console.log(`[PayoutService] ⏳ Order ${orderStatus.status}: ${orderId}`);
              }

              TransactionService.touch(transfer.transactionId, {
                lastKnownStatus: orderStatus.status,
                lastCheckedAt: new Date().toISOString(),
              });
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
            this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
              status: 'FAILED',
              failureReason: failureReason || 'UNKNOWN_ERROR',
            });
            failedTxs.add(transfer.transactionId);
            console.log(`[PayoutService] ✗ FAILED: Order ${orderId} (${failureReason})`);
          } else if (isConfirmed) {
            TransactionService.updateTransactionStatus(transfer.transactionId, 'CONFIRMED', null);
            this._updatePayoutTransfer(payoutId, transfer.fromAddress, {
              status: 'CONFIRMED',
            });
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

    // Anything still unresolved stays PROCESSING. A Bitcoin transfer routinely
    // takes longer than this window to confirm, and a Sideshift swap from BTC
    // longer still; marking those FAILED (as this used to) told the client
    // their money was lost while it was in fact on its way. The maintenance
    // sweep keeps checking the chain and settles them when they land.
    const unresolvedCount = transactionIds.length - confirmedTxs.size - failedTxs.size;
    if (unresolvedCount > 0) {
      console.warn(`[PayoutService] Monitoring window elapsed: ${confirmedTxs.size} confirmed, ${failedTxs.size} failed, ${unresolvedCount} still in flight (left PROCESSING for the maintenance sweep)`);
    } else {
      console.log(`[PayoutService] ✓ All transactions processed: ${confirmedTxs.size} confirmed, ${failedTxs.size} failed!`);
    }

    return {
      confirmedCount: confirmedTxs.size,
      failedCount: failedTxs.size,
      unresolvedCount,
    };
  }

  /**
   * Map a Sideshift order status (or an on-chain status for direct transfers)
   * to an outcome.
   *
   * Sideshift v2 statuses: waiting, pending, processing, review, settling,
   * settled, refund, refunding, refunded, expired, multiple. There is no
   * "failed"; a swap that cannot complete is refunded to the source wallet.
   */
  static classifyOrderStatus(status) {
    switch (String(status || '').toLowerCase()) {
      case 'settled':
        return { confirmed: true };
      case 'expired':
        return { failed: true, reason: 'ORDER_EXPIRED' };
      case 'refunded':
        return { failed: true, reason: 'ORDER_REFUNDED' };
      case 'failed':
        return { failed: true, reason: 'ORDER_FAILED' };
      case 'multiple':
        // Sideshift saw more than one deposit against the order and needs a
        // human to sort it out on their side.
        return { failed: true, reason: 'ORDER_NEEDS_REVIEW' };
      default:
        // waiting, pending, processing, review, settling, refund, refunding,
        // and anything new Sideshift adds: keep watching.
        return { pending: true };
    }
  }

  /**
   * Re-check one in-flight transaction against its chain or Sideshift order
   * and finalise it if it has resolved. Called from the maintenance sweep for
   * transfers whose in-process monitor has already ended.
   *
   * @returns {Promise<'confirmed'|'failed'|'pending'>}
   */
  async reconcileTransaction(transaction) {
    if (!['PENDING', 'PROCESSING'].includes(transaction.status)) return 'pending';
    if (!transaction.orderId) return 'pending';

    const txHash = transaction.transactionHash;
    if (transaction.orderId.startsWith('direct_transfer_') && !txHash) return 'pending';

    const response = await this.sideShift.getOrderStatus(transaction.orderId, txHash, transaction.chain);
    const status = response && response[0] && response[0].status;
    const outcome = PayoutService.classifyOrderStatus(status);

    TransactionService.touch(transaction.id, {
      lastKnownStatus: status,
      lastCheckedAt: new Date().toISOString(),
    });

    if (outcome.confirmed) {
      TransactionService.updateTransactionStatus(transaction.id, 'CONFIRMED', null);
      this._updatePayoutTransferByTransaction(transaction.id, { status: 'CONFIRMED' });
      return 'confirmed';
    }

    if (outcome.failed) {
      TransactionService.markTransactionFailed(transaction.id, outcome.reason, `Order ${transaction.orderId} ${status}`);
      this._updatePayoutTransferByTransaction(transaction.id, { status: 'FAILED', failureReason: outcome.reason });
      return 'failed';
    }

    return 'pending';
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

  /**
   * Update a single transfer entry inside payout.withdrawalPlan.transfers.
   * Matched by fromAddress (unique per transfer within a payout).
   * @param {string} payoutId
   * @param {string} fromAddress
   * @param {Object} updates - fields to merge into the matching transfer
   */
  /**
   * Record the platform fee for one broadcast transfer against its wallet.
   *
   * The fee stays on-chain in the wallet, so it is tracked here so the
   * client's displayed balance reflects only what they can actually withdraw
   * next time. The figure is the exact amount the plan withheld for this
   * wallet, not a USD share worked back through the price feed.
   */
  _recordServiceFee(wallet, transfer) {
    const feeNative = Number(transfer.platformFeeNative) || 0;
    if (!wallet || feeNative <= 0) return;

    const current = db.getById('wallets', wallet.id);
    if (!current) return;

    db.update('wallets', wallet.id, {
      serviceSubtractions: (current.serviceSubtractions || 0) + feeNative,
    });
    console.log(`[PayoutService] Service fee recorded for wallet ${wallet.id} (${transfer.chain}): ${feeNative.toFixed(8)} ${transfer.chain}`);
  }

  /**
   * Find the transfer that produced a transaction and update it.
   */
  _updatePayoutTransferByTransaction(transactionId, updates) {
    for (const payout of db.getAll('payouts')) {
      const transfers = payout.withdrawalPlan && payout.withdrawalPlan.transfers;
      if (!transfers) continue;
      const match = transfers.find((t) => t.transactionId === transactionId);
      if (match) {
        this._updatePayoutTransfer(payout.id, match.fromAddress, updates);
        return payout.id;
      }
    }
    return null;
  }

  _updatePayoutTransfer(payoutId, fromAddress, updates) {
    const payout = db.getById('payouts', payoutId);
    if (!payout?.withdrawalPlan?.transfers) return;

    const transfers = payout.withdrawalPlan.transfers.map(t =>
      t.fromAddress === fromAddress ? { ...t, ...updates } : t
    );

    db.update('payouts', payoutId, {
      withdrawalPlan: { ...payout.withdrawalPlan, transfers },
    });
  }
}

module.exports = new PayoutService();

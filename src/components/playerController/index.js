//Requires
const modulename = 'PlayerController';
const cloneDeep = require('lodash/cloneDeep');
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const { customAlphabet } = require('nanoid');
const { dir, log, logOk, logWarn, logError } = require('../../extras/console')(modulename);

//Helpers
const now = () => { return Math.round(Date.now() / 1000) };
const nanoidAlphabet = "2346789ABCDEFGHJKLMNPQRTUVWXYZ";


/**
 * Provide a central database for players, as well as assist with access control.
 * 
 * FIXME: separate the player calls to another file somehow
 * 
 * Database Structurure:
 *  - `players` table: index by license ID
 *      - license
 *      - name (overwrite on every update)
 *      - tsLastConnection  - Timestamp of the last connection
 *      - playTime - Online time counter in minutes
 *      - notes {
 *          text: string de tamanho máximo a ser definido,
 *          lastAdmin: username,
 *          tsLastEdit: timestamp,
 *      }
 *  - `actions`
 *      - id [X???-????]
 *      - identifiers [array]
 *      - type [ban|warn|whitelist]
 *      - author (the admin name)
 *      - reason
 *      - timestamp
 *      - revocation: {
 *          timestamp: null,
 *          author: null,
 *      }
 *  - `pendingWL`
 *      - id [R????]
 *      - license
 *      - name
 *      - tsLastAttempt
 */
module.exports = class PlayerController {
    constructor(config) {
        logOk('Started');

        //Configs:
        this.config = {};
        this.config.minSessionTime = 1*60; //NOTE: use 15 minutes as default
        this.config.onJoinCheck = {
            ban: false,
            whitelist: false
        }
        this.config.whitelistRejectionMessage = `You are not yet whitelisted in this server.
            Please join <a href="http://discord.gg/example">http://discord.gg/example</a>.
            <strong>Your ID: <id></strong>`;
        this.config.wipePendingWLOnStart = false;

        //Vars
        this.dbo = null;
        this.activePlayers = [];
        this.writePending = false;
        this.validIdentifiers = {
            steam: /steam:1100001[0-9A-Fa-f]{8}/,
            license: /license:[0-9A-Fa-f]{40}/,
            xbl: /xbl:\d{14,20}/,
            live: /live:\d{14,20}/,
            discord: /discord:\d{7,20}/,
            fivem: /fivem:\d{1,8}/,
        }

        //Running playerlist generator
        if(
            process.env.APP_ENV !== 'webpack' && 
            GetConvar('txAdminFakePlayerlist', 'false').trim() === 'yesplz'
        ) {
            const PlayerlistGenerator = require('./playerlistGenerator.js');
            this.playerlistGenerator = new PlayerlistGenerator();
        }

        //Start database instance
        this.setupDatabase();

        //Cron functions
        setInterval(async () => {
            await this.processActive();

            try {
                if(this.writePending){
                    await this.dbo.write();
                    this.writePending = false;
                    // if(GlobalData.verbose) logOk('Writing DB'); //DEBUG
                }
            } catch (error) {
                logError(`Failed to save players database with error: ${error.message}`);
                if(GlobalData.verbose) dir(error);
            }
        }, 15 * 1000);
    }


    //================================================================
    /**
     * Start lowdb instance and set defaults
     */
    async setupDatabase(){
        let dbPath = `${globals.info.serverProfilePath}/data/playersDB.json`;
        try {
            const adapterAsync = new FileAsync(dbPath); //DEBUG
            // const adapterAsync = new FileAsync(dbPath, {
            //     defaultValue: {}, 
            //     serialize: JSON.stringify, 
            //     deserialize: JSON.parse
            // });
            this.dbo = await low(adapterAsync);
            await this.dbo.defaults({
                version: 0,
                players: [],
                actions: [],
                pendingWL: []
            }).write();
            // await this.dbo.set('players', []).write(); //DEBUG
            if(this.config.wipePendingWLOnStart) await this.dbo.set('pendingWL', []).write();
        } catch (error) {
            logError(`Failed to load database file '${dbPath}'`);
            if(GlobalData.verbose) dir(error);
            process.exit();
        }
    }


    //================================================================
    /**
     * Returns the entire lowdb object. Please be careful with it :)
     * @returns {object} lodash database
     */
    getDB(){
        return this.dbo;
    }


    //================================================================
    /**
     * Processes the active players for playtime/sessiontime and sets to the database
     */
    async processActive(){
        try {
            this.activePlayers.forEach(async p => {
                let sessionTime = now() - p.tsConnected;

                //If its time to add this player to the database
                if(p.isTmp && sessionTime >= this.config.minSessionTime){
                    if(p.license == '3333333333333333333333deadbeef0000nosave') return; //DEBUG

                    this.writePending = true;
                    p.isTmp = false;
                    p.playTime = Math.round(sessionTime/60);
                    p.notes = {
                        text: '',
                        lastAdmin: null,
                        tsLastEdit: null
                    }
                    let toDB = {
                        license: p.license,
                        name: p.name,
                        playTime: p.playTime,
                        tsJoined: p.tsJoined,
                        tsLastConnection: p.tsConnected,
                        notes: p.notes
                    }
                    await this.dbo.get('players')
                        .push(toDB)
                        .value();
                    if(GlobalData.verbose) logOk(`Adding '${p.name}' to players database.`);
                    
                //If its time to update this player's play time
                }else if(!p.isTmp && Math.round(sessionTime/4) % 4 == 0){
                    this.writePending = true;
                    p.playTime += 1; 
                    await this.dbo.get("players")
                        .find({license: p.license})
                        .assign({
                            name: p.name, 
                            playTime: p.playTime, 
                            notes: p.notes,
                            tsLastConnection: p.tsConnected
                        })
                        .value();
                    // logOk(`Updating '${p.name}' in players database.`); //DEBUG
                }
            });
        } catch (error) {
            logError(`Failed to process active players array with error: ${error.message}`);
            if(GlobalData.verbose) dir(error);
        }
    }


    //================================================================
    /**
     * Searches for a player in the database by the license
     * @param {string} license 
     * @returns {object|null|false} object if player is found, null if not found, false if error occurs
     */
    async getPlayer(license){
        try {
            let p = await this.dbo.get("players").find({license: license}).value();
            return (typeof p === 'undefined')? null : p;
        } catch (error) {
            if(GlobalData.verbose) logError(`Failed to search for a player in the database with error: ${error.message}`);
            return false;
        }
    }


    //================================================================
    /**
     * Searches for a registered action in the database by a list of identifiers and optional filters
     * Usage example: getRegisteredActions(['license:xxx'], {type: 'ban', revocation.timestamp: null})
     * 
     * NOTE: I haven't actually benchmarked to make sure passing the filter first increases the performance
     * 
     * @param {array} idArray identifiers array
     * @param {object} filter lodash-compatible filter object
     * @returns {array|error} array of actions, or, throws on error
     */
    async getRegisteredActions(idArray, filter = {}){
        if(!Array.isArray(idArray)) throw new Error('Identifiers should be an array');
        try {
            let actions = await this.dbo.get("actions")
                                .filter(filter)
                                .filter(a => idArray.some((fi) => a.identifiers.includes(fi)))
                                .value();
            return cloneDeep(actions);
        } catch (error) {
            const msg = `Failed to search for a registered action database with error: ${error.message}`;
            if(GlobalData.verbose) logError(msg);
            throw new Error(msg);
        }
    }


    //================================================================
    /**
     * Processes an playerConnecting validation request
     * 
     * TODO: improve ban message to be more verbose
     * 
     * @param {array} idArray identifiers array
     * @param {string} name player name
     * @returns {object} {allow: bool, reason: string}, or throws on error
     */
    async checkPlayerJoin(idArray, playerName){
        //Check if required
        if(!this.config.onJoinCheck.ban && !this.config.onJoinCheck.whitelist){
            return {allow: true, reason: 'checks disabled'};
        }

        //Sanity checks
        if(typeof playerName !== 'string') throw new Error('playerName should be an string.');
        if(!Array.isArray(idArray)) throw new Error('Identifiers should be an array with at least 1 identifier.');
        idArray = idArray.filter((id)=>{
            return Object.values(this.validIdentifiers).some(vf => vf.test(id));
        });
        
        try {
            //Prepare & query
            let ts = now();
            const filter = (x) => {
                return (
                    (x.type == 'ban' || x.type == 'whitelist') &&
                    (!x.expiration || x.expiration > ts) &&
                    (!x.revocation.timestamp)
                );
            }
            let hist = await this.getRegisteredActions(idArray, filter);

            //Check ban
            if(this.config.onJoinCheck.ban){
                let ban = hist.find((a) => a.type = 'ban');
                if(ban){
                    let msg = `You have been banned from this server.\nBan ID: ${ban.id}.`;
                    return {allow: false, reason: msg};
                }
            }

            //Check whitelist
            if(this.config.onJoinCheck.whitelist){
                let wl = hist.find((a) => a.type == 'whitelist');
                if(!wl){
                    //Get license
                    let license = idArray.find((id) => id.substring(0, 8) == "license:");
                    if(!license) return {allow: false, reason: 'the whitelist module requires a license identifier.'}
                    license = license.substring(8);
                    //Check for pending WL requests
                    let pending = await this.dbo.get("pendingWL").find({license: license}).value();
                    let whitelistID;
                    if(pending){
                        pending.name = playerName;
                        pending.tsLastAttempt = now();
                        whitelistID = pending.id;
                    }else{
                        whitelistID = 'R' + customAlphabet(nanoidAlphabet, 4)()
                        let toDB = {
                            id: whitelistID,
                            name: playerName,
                            license: license,
                            tsLastAttempt: now()
                        }
                        await this.dbo.get('pendingWL').push(toDB).value();
                    }
                    this.writePending = true;

                    let reason = this.config.whitelistRejectionMessage.replace(`<id>`, whitelistID);
                    return {allow: false, reason};
                }
            }

            return {allow: true, reason: null};
        } catch (error) {
            const msg = `Failed to check whitelist/blacklist: ${error.message}`;
            logError(msg);
            if(GlobalData.verbose) dir(error);
            return {allow: false, reason: msg};
        }
    }


    //================================================================
    /**
     * Registers an action (ban, warn, whitelist)
     * @param {array|number} reference identifiers array or server id
     * @param {string} type [ban|warn|whitelist]
     * @param {string} author admin name
     * @param {string} reason reason
     * @param {number|false} expiration reason
     * @returns {string} action ID, or throws if on error or ID not found
     */
    async registerAction(reference, type, author, reason, expiration){
        //Processes target reference
        let identifiers;
        if(Array.isArray(reference)){
            if(!reference.length) throw new Error('You must send at least one identifier');
            let invalids = reference.filter((id)=>{
                return (typeof id !== 'string') || !Object.values(this.validIdentifiers).some(vf => vf.test(id));
            });
            if(invalids.length){
                throw new Error('Invalid identifiers: ' + invalids.join(', '));
            }else{
                identifiers = reference;
            }
        }else if(typeof reference == 'number'){
            let player = this.activePlayers.find((p) => p.id === reference);
            if(!player) throw new Error('player disconnected.');
            if(!player.identifiers.length) throw new Error('player has no identifiers.'); //sanity check
            identifiers = player.identifiers;
        }else{
            throw new Error(`Reference expected to be an array of strings or id. Received '${typeof target}'.`)
        }

        //Saves it to the database
        let actionPrefix = (type == 'warn')? 'a' : type[0];
        let actionID = actionPrefix.toUpperCase() + customAlphabet(nanoidAlphabet, 3)() + '-' + customAlphabet(nanoidAlphabet, 4)();
        let toDB = {
            id: actionID,
            type,
            author,
            reason,
            expiration: (typeof expiration == 'number')? expiration : false,
            timestamp: now(),
            identifiers,
            revocation: {
                timestamp: null,
                author: null,
            }
        }
        try {
            await this.dbo.get('actions')
                .push(toDB)
                .value();
            this.writePending = true;
        } catch (error) {
            let msg = `Failed to register event to database with message: ${error.message}`;
            logError(msg);
            if(GlobalData.verbose) dir(error);
            throw new Error(msg)
        }


        return actionID;
    }


    //================================================================
    /**
     * Revoke an action (ban, warn, whitelist)
     * @param {string} actionID action id
     * @param {string} author admin name
     * @returns {string} action ID, or throws if ID not found
     */
    async revokeAction(reference, author){
        throw new Error(`not implemented yet ☹`);
    }


    //================================================================
    /**
     * Saves a player notes and returns true/false
     * Usage example: setPlayerNote('xxx', 'super awesome player', 'tabarra')
     * @param {string} license
     * @param {string} note
     * @param {string} author
     * @returns {boolean} 
     */
    async setPlayerNote(license, note, author){
        try {
            //Search player
            let target;
            let ap = globals.playerController.activePlayers.find(p => p.license === license);
            if(ap){
                target = ap;
            }else{
                let dbp = await this.dbo.get("players").find({license: license}).value();
                if(!dbp) return false;
                target = dbp;
            }

            //Add note and set pending flag
            target.notes = {
                text: note,
                lastAdmin: author,
                tsLastEdit: now()
            }
            this.writePending = true;
            
            return true;
        } catch (error) {
            if(GlobalData.verbose) logError(`Failed to search for a registered action database with error: ${error.message}`);
            return false;
        }
    }


    //================================================================
    /**
     * Returns a mostly /players.json compatible playerlist based on the activePlayers
     * 
     * NOTE: ATM only used by the /status endpoint.
     *       Let's try to use just clone(globals.playerController.activePlayers)
     * 
     * @returns {array} array of player objects
     */
    getPlayerList(){
        try {
            return this.activePlayers.map(p => {
                return {
                    license: p.license,
                    id: p.id,
                    name: p.name,
                    ping: p.ping,
                    identifiers: p.identifiers,
                }
            });
        } catch (error) {
            if(GlobalData.verbose) logError(`Failed to generate playerlist with error: ${error.message}`);
            return false;
        }
    }


    //================================================================
    /**
     * Processes the monitor heartbeat to update internal active playerlist.
     * Macro view of this function:
     *  -For all removed players = remove from this.activePlayers
     *  -For all new players:
     *      - search for them in the db
     *      - add them to the active players containing:
     *          - some prop to indicate if its present in the database
     *          - tsConnected
     * 
     * NOTE:  This code was written this way to improve performance in exchange of readability
     *           the ES6 gods might not like this..
     * TODO: To prevent retaliation from the gods, consider making the activePlayers a Map instead of an Array.
     * 
     * FIXME: I'm guaranteeing there are not two players with the same License, but not ID.
     * 
     * @param {array} players
     */
    async processHeartBeat(players){
        //DEBUG: in case the player generator is enabled
        if(this.playerlistGenerator) players = this.playerlistGenerator.playerlist;

        try {
            //Sanity check
            if(!Array.isArray(players)) throw new Error('expected array');
            
            //Validate & filter players then extract ids and license
            let pCount = players.length; //Optimization only, although V8 is probably smart enough
            let hbPlayers = new Map();
            let invalids = 0;
            let duplicated = 0;
            for (let i = 0; i < pCount; i++) {
                let p = Object.assign({}, players[i]);

                //Basic struct
                if(
                    typeof p !== 'object' ||
                    typeof p.name !== 'string' ||
                    typeof p.id !== 'number' ||
                    typeof p.license !== 'undefined' ||
                    !Array.isArray(p.identifiers) ||
                    !p.identifiers.length
                ){
                    invalids++;
                    continue;
                }

                //Extract license
                for (let j = 0; j < p.identifiers.length; j++) {
                    if(p.identifiers[j].length == 48 && p.identifiers[j].substring(0, 8) == "license:"){
                        p.license = p.identifiers[j].substring(8);
                        break;
                    }
                }

                //Check if license id exist and is not duplicated
                if(typeof p.license !== 'string'){
                    invalids++;
                    continue;
                }
                if(hbPlayers.has(p.license)){
                    duplicated++;
                    continue;
                }

                //Add to licenses list
                delete p.endpoint;
                hbPlayers.set(p.license, p)
            }
            //FIXME: make this verbose only
            if(invalids) logWarn(`HeartBeat playerlist contained ${invalids} invalid players that were removed.`); 
            if(duplicated) logWarn(`HeartBeat playerlist contained ${duplicated} duplicated players that were removed.`); 
            

            //Processing active players list, creating the removed list, creating new active list without removed players
            let apCount = this.activePlayers.length;  //Optimization only, although V8 is probably smart enough
            let disconnectedPlayers = [];
            let activePlayerLicenses = []; //Optimization only
            let newActivePlayers = [];
            for (let i = 0; i < apCount; i++) {
                let hbPlayerData = hbPlayers.get(this.activePlayers[i].license);  
                if(hbPlayerData){
                    let updatedPlayer = Object.assign(
                        this.activePlayers[i], 
                        {
                            id: hbPlayerData.id, //NOTE: possibly the solution to the double player issue?
                            ping: hbPlayerData.ping,
                            // extraData: hbPlayerData.extraData //NOTE: reserve for RolePlay data from frameworks
                        }
                    );
                    newActivePlayers.push(updatedPlayer);
                    activePlayerLicenses.push(this.activePlayers[i].license);
                }else{
                    disconnectedPlayers.push(this.activePlayers[i]);
                }
            }

            //Processing the new players
            for (const [license, player] of hbPlayers) {
                //Make sure we are not adding the same user twice
                if(!activePlayerLicenses.includes(player.license)){
                    //Filter to only valid identifiers
                    player.identifiers = player.identifiers.filter((id)=>{
                        return Object.values(this.validIdentifiers).some(vf => vf.test(id));
                    });
                    //Check if he is already on the database
                    let dbPlayer = await this.getPlayer(license);
                    if(dbPlayer){
                        //TODO: create a AllAssocIds for the players, containing all intersecting identifiers
                        let newPlayer = Object.assign({}, player, {
                            tsJoined: dbPlayer.tsJoined, 
                            playTime: dbPlayer.playTime, 
                            tsConnected: now(), 
                            isTmp: false,
                            notes: dbPlayer.notes
                        });
                        newActivePlayers.push(newPlayer);
                    }else{
                        let tsNow = now();
                        player.tsJoined = tsNow;
                        player.tsConnected = tsNow;
                        player.isTmp = true;
                        newActivePlayers.push(player);
                    }
                }
            }

            //Committing disconnected players data
            //NOTE: I'm only assigning the notes because that's currently the only thing that can change between saves.
            if(disconnectedPlayers.length) this.writePending = true;
            disconnectedPlayers.forEach(async (p) => {
                try {
                    await this.dbo.get("players")
                        .find({license: p.license})
                        .assign({
                            notes: p.notes,
                        })
                        .value();
                } catch (error) {
                    logError(`Failed to save the the following disconnected player to the database with error: ${error.message}`);
                    dir(p);
                }
            });

            //Replacing the active playerlist
            this.activePlayers = newActivePlayers;
        } catch (error) {
            if(GlobalData.verbose){
                logError(`PlayerController failed to process HeartBeat with error: ${error.message}`);
                dir(error);
            }
        }
    }//Fim processHeartBeat()

} //Fim Database()

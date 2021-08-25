Zotero.Jasminum = new function () {
    // Default values
    this.userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.77 Safari/537.36";
    this.CNDB = ['CNKI'];
    this.CookieSandbox = null;
    this.RefCookieSandbox = null;

    /**
     * Initiate addon
     */
    this.init = async function () {
        // Register the callback in Zotero as an item observer
        var notifierID = Zotero.Notifier.registerObserver(
            this.notifierCallback,
            ["item"]
        );
        // Unregister callback when the window closes (important to avoid a memory leak)
        window.addEventListener(
            "unload",
            function (e) {
                Zotero.Notifier.unregisterObserver(notifierID);
            },
            false
        );
        // 等待数据维护更新完毕
        // await Zotero.Schema.schemaUpdatePromise;

        this.initPref();
        Components.utils.import("resource://gre/modules/osfile.jsm");
        Zotero.debug("Init Jasminum ...");
    };

    /**
     * Initiate Jasminum preferences
     */
    this.initPref = function () {
        if (Zotero.Prefs.get("jasminum.pdftkpath") === undefined) {
            var pdftkpath = "C:\\Program Files (x86)\\PDFtk Server\\bin";
            if (Zotero.isLinux) {
                pdftkpath = "/usr/bin";
            } else if (Zotero.isMac) {
                pdftkpath = "/opt/pdflabs/pdftk/bin";
            }
            Zotero.Prefs.set("jasminum.pdftkpath", pdftkpath);
        }
        if (Zotero.Prefs.get("jasminum.autoupdate") === undefined) {
            Zotero.Prefs.set("jasminum.autoupdate", false);
        }
        if (Zotero.Prefs.get("jasminum.namepatent") === undefined) {
            Zotero.Prefs.set("jasminum.namepatent", "{%t}_{%g}");
        }
        if (Zotero.Prefs.get("jasminum.zhnamesplit") === undefined) {
            Zotero.Prefs.set("jasminum.zhnamesplit", true);
        }
        if (Zotero.Prefs.get("jasminum.rename") === undefined) {
            Zotero.Prefs.set("jasminum.rename", true);
        }
        if (Zotero.Prefs.get("jasminum.autobookmark") === undefined) {
            Zotero.Prefs.set("jasminum.autobookmark", true);
        }
    };

    this.notifierCallback = {
        // Check new added item, and adds meta data.
        notify: async function (event, type, ids, extraData) {
            // var automatic_pdf_download_bool = Zotero.Prefs.get('zoteroscihub.automatic_pdf_download');
            if (event == "add") {
                // Auto update meta data
                var addedItems = Zotero.Items.get(ids);
                if (Zotero.Prefs.get("jasminum.autoupdate")) {
                    Zotero.debug("** Jasminum new items added.");
                    var items = [];
                    for (let item of addedItems) {
                        if (Zotero.Jasminum.UI.isCNKIFile(item)) {
                            items.push(item);
                        }
                    }
                    Zotero.debug(`** Jasminum add ${items.length} items`);
                    Zotero.Jasminum.searchItems(items);
                }
                // Split or merge name
                if (!Zotero.Prefs.get("jasminum.zhnamesplit")) {
                    Zotero.debug("** Jasminum merge CN name");
                    var items = [];
                    for (let item of addedItems) {
                        if (
                            Zotero.Jasminum.CNDB.includes(
                                item.getField("libraryCatalog")
                            )
                        ) {
                            items.push(item);
                        }
                    }
                    Zotero.Jasminum.mergeName(items);
                }
                // Add bookmark after new PDF is attached.
                if (Zotero.Prefs.get("jasminum.autobookmark")) {
                    for (let item of addedItems) {
                        if (
                            item.parentID &&
                            Zotero.ItemTypes.getName(
                                item.parentItem.itemTypeID
                            ) == "thesis" &&
                            item.parentItem.getField("libraryCatalog") ==
                            "CNKI" &&
                            item.attachmentContentType == "application/pdf"
                        ) {
                            Zotero.debug("***** New PDF item is added");
                            await Zotero.Jasminum.addBookmarkItem(item);
                        }
                    }
                }
            }
        },
    };


    /**
     * For selected CNKI attachments. Retrive keywords from file name.
     * And Search CNKI meta-data by these keywords
     * @return {volid}
     */
    this.searchSelectedItems = function () {
        Zotero.debug("**Jasminum Updating Selected items");
        this.searchItems(ZoteroPane.getSelectedItems());
    };


    this.searchItems = async function (items) {
        if (items.length == 0) return;
        var item = items.shift();
        var itemCollections = item.getCollections();
        var libraryID = item.libraryID;
        // Retrive meta data for webpage item
        if (Zotero.ItemTypes.getName(item.itemTypeID) === "webpage") {
            Zotero.debug("** Jasminum add webpage.");
            let articleId = this.Scrape.getIDFromUrl(item.getField("url"));
            Zotero.debug([articleId]);
            let postData = this.Scrape.createRefPostData([articleId]);
            let data = await this.Scrape.getRefText(postData);
            Zotero.debug(data.split("\n"));
            var newItems = await this.Utils.trans2Items(data, libraryID);
            let targetData = {
                targetUrls: [item.getField("url")],
                citations: [null]
            };
            newItems = await this.Utils.fixItem(newItems, targetData);
            // Move notes to newItems
            if (item.getNotes()) {
                for (let noteID of item.getNotes()) {
                    var noteItem = Zotero.Items.get(noteID);
                    noteItem.parentID = newItems[0].id;
                    await noteItem.saveTx();
                }
            }
            // Move item to Trash
            item.deleted = true;
            await item.saveTx();

        } else {
            var fileData = this.Scrape.splitFilename(item.getFilename());
            Zotero.debug(fileData);
            var targetRows = await this.Scrape.search(fileData);
            // 有查询结果返回
            if (targetRows && targetRows.length > 0) {
                var [data, targetData] = await this.Scrape.getRefworks(
                    targetRows
                );
                var newItems = await this.Utils.trans2Items(data, libraryID);
                Zotero.debug(newItems);
                newItems = await this.Utils.fixItem(newItems, targetData);
                Zotero.debug("** Jasminum DB trans ...");
                if (itemCollections.length) {
                    for (let collectionID of itemCollections) {
                        newItems.forEach(function (item) {
                            item.addToCollection(collectionID);
                        });
                    }
                }
                // 只有单个返回结果
                if (newItems.length == 1) {
                    var newItem = newItems[0];
                    // Put old item as a child of the new item
                    item.parentID = newItem.id;
                    // Use Zotfile to rename file
                    if (
                        Zotero.Prefs.get("jasminum.rename") &&
                        typeof Zotero.ZotFile != "undefined"
                    ) {
                        Zotero.ZotFile.renameSelectedAttachments();
                    }

                    await item.saveTx();
                    await newItem.saveTx();
                    // Add bookmark after PDF attaching to new item
                    if (
                        Zotero.Prefs.get("jasminum.autobookmark") &&
                        this.UI.isCNKIPDF(item)
                    ) {
                        await this.addBookmarkItem(item);
                    }
                } else {
                    // 有多个返回结果，将文件与新条目关联，用于用户后续手动选择
                    newItems.forEach(function (newItem) {
                        item.addRelatedItem(newItem);
                    });
                    await item.saveTx();
                }

                Zotero.debug("** Jasminum finished.");
            } else {
                // 没有查询结果
                alert(
                    `No result found!\n作者：${fileData.author}\n篇名：${fileData.keyword}\n请检查设置中的文件名模板是否与实际实际情况相符`
                );
            }
        }
        if (items.length) {
            this.searchItems(items);
        }
    };



    this.addBookmarkItem = async function () {
        var item = ZoteroPane.getSelectedItems()[0];
        if (!(await this.Scrape.checkPath())) {
            alert(
                "Can't find PDFtk Server execute file. Please install PDFtk Server and choose the folder in the Jasminum preference window."
            );
            return false;
        }
        // Show alert when file is missing
        var attachmentExists = await OS.File.exists(item.getFilePath());
        if (!attachmentExists) {
            alert("Item Attachment file is missing.");
            return false;
        }
        var bookmark, note;
        [bookmark, note] = await this.Scrape.getBookmark(item);
        if (!bookmark) {
            alert("No Bookmark found!\n书签信息未找到");
        } else {
            // Add TOC note
            var noteHTML = item.getNote();
            noteHTML += note;
            item.setNote(noteHTML);
            await item.saveTx();
            await this.Scrape.addBookmark(item, bookmark);
        }
    };


    this.splitNameM = function () {
        var items = ZoteroPane.getSelectedItems();
        this.splitName(items);
    };

    this.mergeNameM = function () {
        var items = ZoteroPane.getSelectedItems();
        this.mergeName(items);
    };

    this.splitName = async function (items) {
        for (let item of items) {
            var creators = item.getCreators();
            for (var i = 0; i < creators.length; i++) {
                var creator = creators[i];
                if (
                    // English Name pass
                    creator.lastName.search(/[A-Za-z]/) !== -1 ||
                    creator.firstName.search(/[A-Za-z]/) !== -1 ||
                    creator.firstName // 如果有名就不拆分了
                ) {
                    var EnglishName = creator.lastName;
                    var temp = EnglishName.split(/[\n\s+,]/g);
                    for (var k = 0; k < temp.length; k++) {
                        if (temp[k] == "") {
                            // 删除数组中空值
                            temp.splice(k, 1);
                            k--;
                        }
                    }
                    if (temp.length < 3) {
                        creator.lastName = temp[0];
                        creator.firstName = temp[1];
                    } else {
                        creator.lastName = temp[0];
                        creator.firstName = temp[1].concat(" ", temp[2]);
                    }
                    creator.fieldMode = 0;// 0: two-field, 1: one-field (with empty first name)
                    creators[i] = creator;
                } else {  // For Chinese Name
                    var chineseName = creator.lastName
                        ? creator.lastName
                        : creator.firstName;
                    creator.lastName = chineseName.charAt(0);
                    creator.firstName = chineseName.substr(1);
                    creator.fieldMode = 0;
                    creators[i] = creator;
                }
            }
            if (creators != item.getCreators()) {
                item.setCreators(creators);
                item.saveTx();
            }
        }
    };

    this.mergeName = async function (items) {
        for (let item of items) {
            var creators = item.getCreators();
            for (var i = 0; i < creators.length; i++) {
                var creator = creators[i];
                if (
                    // English Name pass
                    creator.lastName.search(/[A-Za-z]/) !== -1 ||
                    creator.lastName.search(/[A-Za-z]/) !== -1
                ) {
                    creator.lastName = creator.lastName + " " + creator.firstName;
                    creator.firstName = "";
                    creator.fieldMode = 1;// 0: two-field, 1: one-field (with empty first name)
                    creators[i] = creator;
                } else { // For Chinese Name
                    creator.lastName = creator.lastName + creator.firstName;
                    creator.firstName = "";
                    creator.fieldMode = 1;
                    creators[i] = creator;
                }
            }
            if (creators != item.getCreators()) {
                item.setCreators(creators);
                item.saveTx();
            }
        }
    };

    this.removeDotM = function () {
        var items = ZoteroPane.getSelectedItems();
        this.removeDot(items);
    };

    this.removeDot = async function (items) {
        for (let item of items) {
            var attachmentIDs = item.getAttachments();
            for (let id of attachmentIDs) {
                var atta = Zotero.Items.get(id);
                var newName = atta.attachmentFilename.replace(
                    /([_\u4e00-\u9fa5]), ([_\u4e00-\u9fa5])/g,
                    "$1$2"
                );
                await atta.renameAttachmentFile(newName);
                atta.setField("title", newName);
                atta.saveTx();
            }
        }
    };

    /**
     * Update citation in Zotero item field
     * 110 citations(CNKI)[2021-08-22]<北大核心, CSCI>
     * @param {[Zotero.item]}
     * @return {volid}
     */
    this.updateCiteCSSCI = async function (items) {
        var item = items.shift();
        let url = item.getField("url");
        let resp = await Zotero.HTTP.request("GET", url);
        let html = this.Utils.string2HTML(resp.responseText);
        let dateString = new Date().toLocaleDateString().replace(/\//g, '-');
        let cite = this.Scrape.getCitationFromPage(html);
        let citeString = cite + " citation(CNKI)[" + dateString + "]";
        let cssci = this.Scrape.getCSSCI(html);
        let cssciString = "<" + cssci + ">";
        var extraData = item.getField("extra");

        if (cite) {
            if (extraData.match(/\d+ citations\s?\(CNKI\)\s?\[\d{4}-\d{1,2}-\d{1,2}\]/)) {
                extraData = extraData.replace(/\d+ citations\s?\(CNKI\)\s?\[\d{4}-\d{1,2}-\d{1,2}\]/,
                    citeString);
            } else {
                extraData += citeString;
            }
        }

        if (cssci) {
            if (extraData.match(/<.*?>/)) {
                extraData = extraData.replace(/<.*?>/, cssciString);
            } else {
                extraData += cssciString;
            }
        }
        Zotero.debug(cite);
        Zotero.debug(cssci);
        Zotero.debug("** Jasminum " + extraData);
        item.setField("extra", extraData);
        await item.saveTx();

        if (items.length) {
            this.updateCiteCSSCI(items);
        }
    };

    this.updateCiteCSSCIItems = function () {
        var items = ZoteroPane.getSelectedItems();
        this.updateCiteCSSCI(items);
    };

};

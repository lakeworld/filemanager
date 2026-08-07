export namespace frontend {
	
	export class FileFilter {
	    DisplayName: string;
	    Pattern: string;
	
	    static createFrom(source: any = {}) {
	        return new FileFilter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.DisplayName = source["DisplayName"];
	        this.Pattern = source["Pattern"];
	    }
	}

}

export namespace main {
	
	export class ApiResult__certmanager_internal_updater_UpdateInfo_ {
	    success: boolean;
	    data?: updater.UpdateInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult__certmanager_internal_updater_UpdateInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], updater.UpdateInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WorkspaceInfo {
	    path: string;
	    name: string;
	    created_at: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.created_at = source["created_at"];
	    }
	}
	export class ApiResult__main_WorkspaceInfo_ {
	    success: boolean;
	    data?: WorkspaceInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult__main_WorkspaceInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], WorkspaceInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult____3_string_ {
	    success: boolean;
	    data: string[][];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult____3_string_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = source["data"];
	        this.error = source["error"];
	    }
	}
	export class FileEntry {
	    name: string;
	    path: string;
	    size: number;
	    modified: string;
	    file_type: string;
	    thumbnail_path: string;
	
	    static createFrom(source: any = {}) {
	        return new FileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.modified = source["modified"];
	        this.file_type = source["file_type"];
	        this.thumbnail_path = source["thumbnail_path"];
	    }
	}
	export class ApiResult___main_FileEntry_ {
	    success: boolean;
	    data: FileEntry[];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult___main_FileEntry_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], FileEntry);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProductSetInfo {
	    name: string;
	    image_count: number;
	    cert_count: number;
	    created_at: string;
	    tags: string[];
	    notes: string;
	
	    static createFrom(source: any = {}) {
	        return new ProductSetInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.image_count = source["image_count"];
	        this.cert_count = source["cert_count"];
	        this.created_at = source["created_at"];
	        this.tags = source["tags"];
	        this.notes = source["notes"];
	    }
	}
	export class ApiResult___main_ProductSetInfo_ {
	    success: boolean;
	    data: ProductSetInfo[];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult___main_ProductSetInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], ProductSetInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult___main_WorkspaceInfo_ {
	    success: boolean;
	    data: WorkspaceInfo[];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult___main_WorkspaceInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], WorkspaceInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_bool_ {
	    success: boolean;
	    data: boolean;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_bool_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = source["data"];
	        this.error = source["error"];
	    }
	}
	export class DashboardStats {
	    total_product_sets: number;
	    total_images: number;
	    total_certs: number;
	    expiring_certs: number;
	    recent_files: FileEntry[];
	
	    static createFrom(source: any = {}) {
	        return new DashboardStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total_product_sets = source["total_product_sets"];
	        this.total_images = source["total_images"];
	        this.total_certs = source["total_certs"];
	        this.expiring_certs = source["expiring_certs"];
	        this.recent_files = this.convertValues(source["recent_files"], FileEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_DashboardStats_ {
	    success: boolean;
	    data: DashboardStats;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_DashboardStats_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], DashboardStats);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileMetadata {
	    cert_type: string;
	    expiry_date: string;
	    tags: string[];
	    notes: string;
	    added_at: string;
	
	    static createFrom(source: any = {}) {
	        return new FileMetadata(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cert_type = source["cert_type"];
	        this.expiry_date = source["expiry_date"];
	        this.tags = source["tags"];
	        this.notes = source["notes"];
	        this.added_at = source["added_at"];
	    }
	}
	export class ApiResult_main_FileMetadata_ {
	    success: boolean;
	    data: FileMetadata;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_FileMetadata_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], FileMetadata);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LicenseInfo {
	    license: string;
	    email: string;
	    type: string;
	    activated_at: string;
	    fingerprint: string;
	    is_trial: boolean;
	    expires_at: string;
	    trial_expired: boolean;
	    days_left: number;
	
	    static createFrom(source: any = {}) {
	        return new LicenseInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.license = source["license"];
	        this.email = source["email"];
	        this.type = source["type"];
	        this.activated_at = source["activated_at"];
	        this.fingerprint = source["fingerprint"];
	        this.is_trial = source["is_trial"];
	        this.expires_at = source["expires_at"];
	        this.trial_expired = source["trial_expired"];
	        this.days_left = source["days_left"];
	    }
	}
	export class ApiResult_main_LicenseInfo_ {
	    success: boolean;
	    data: LicenseInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_LicenseInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], LicenseInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LicenseStatus {
	    activated: boolean;
	    info: LicenseInfo;
	
	    static createFrom(source: any = {}) {
	        return new LicenseStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.activated = source["activated"];
	        this.info = this.convertValues(source["info"], LicenseInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_LicenseStatus_ {
	    success: boolean;
	    data: LicenseStatus;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_LicenseStatus_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], LicenseStatus);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_ProductSetInfo_ {
	    success: boolean;
	    data: ProductSetInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_ProductSetInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], ProductSetInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProductSetStats {
	    image_count: number;
	    cert_count: number;
	    created_at: string;
	
	    static createFrom(source: any = {}) {
	        return new ProductSetStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.image_count = source["image_count"];
	        this.cert_count = source["cert_count"];
	        this.created_at = source["created_at"];
	    }
	}
	export class ApiResult_main_ProductSetStats_ {
	    success: boolean;
	    data: ProductSetStats;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_ProductSetStats_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], ProductSetStats);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SearchResult {
	    files: FileEntry[];
	    product_sets: ProductSetInfo[];
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.files = this.convertValues(source["files"], FileEntry);
	        this.product_sets = this.convertValues(source["product_sets"], ProductSetInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_SearchResult_ {
	    success: boolean;
	    data: SearchResult;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_SearchResult_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], SearchResult);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NamingTemplate {
	    product_set_prefix: string;
	    product_set_suffix: string;
	    sku_separator: string;
	    sku_fields: string[];
	    conflict_suffix: string;
	
	    static createFrom(source: any = {}) {
	        return new NamingTemplate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.product_set_prefix = source["product_set_prefix"];
	        this.product_set_suffix = source["product_set_suffix"];
	        this.sku_separator = source["sku_separator"];
	        this.sku_fields = source["sku_fields"];
	        this.conflict_suffix = source["conflict_suffix"];
	    }
	}
	export class WorkspaceConfig {
	    name: string;
	    naming_template: NamingTemplate;
	    image_subfolders: string[];
	    cert_subfolders: string[];
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.naming_template = this.convertValues(source["naming_template"], NamingTemplate);
	        this.image_subfolders = source["image_subfolders"];
	        this.cert_subfolders = source["cert_subfolders"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_WorkspaceConfig_ {
	    success: boolean;
	    data: WorkspaceConfig;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_WorkspaceConfig_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], WorkspaceConfig);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_main_WorkspaceInfo_ {
	    success: boolean;
	    data: WorkspaceInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_main_WorkspaceInfo_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = this.convertValues(source["data"], WorkspaceInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ApiResult_string_ {
	    success: boolean;
	    data: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ApiResult_string_(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.data = source["data"];
	        this.error = source["error"];
	    }
	}
	
	export class DeleteSubfolderRequest {
	    product_set: string;
	    file_type: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new DeleteSubfolderRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.product_set = source["product_set"];
	        this.file_type = source["file_type"];
	        this.name = source["name"];
	    }
	}
	
	export class FileListRequest {
	    product_set: string;
	    file_type: string;
	    sub_folder: string;
	
	    static createFrom(source: any = {}) {
	        return new FileListRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.product_set = source["product_set"];
	        this.file_type = source["file_type"];
	        this.sub_folder = source["sub_folder"];
	    }
	}
	
	export class FileRenameRequest {
	    path: string;
	    newName: string;
	
	    static createFrom(source: any = {}) {
	        return new FileRenameRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.newName = source["newName"];
	    }
	}
	export class ImportFileRequest {
	    source_paths: string[];
	    target_product_set: string;
	    target_folder: string;
	    target_type: string;
	    sub_folder: string;
	
	    static createFrom(source: any = {}) {
	        return new ImportFileRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source_paths = source["source_paths"];
	        this.target_product_set = source["target_product_set"];
	        this.target_folder = source["target_folder"];
	        this.target_type = source["target_type"];
	        this.sub_folder = source["sub_folder"];
	    }
	}
	export class LicenseActivateRequest {
	    license: string;
	    email: string;
	    code: string;
	
	    static createFrom(source: any = {}) {
	        return new LicenseActivateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.license = source["license"];
	        this.email = source["email"];
	        this.code = source["code"];
	    }
	}
	
	
	export class MetadataUpdateRequest {
	    product_set: string;
	    file_name: string;
	    cert_type: string;
	    expiry_date: string;
	    tags: string[];
	    notes: string;
	
	    static createFrom(source: any = {}) {
	        return new MetadataUpdateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.product_set = source["product_set"];
	        this.file_name = source["file_name"];
	        this.cert_type = source["cert_type"];
	        this.expiry_date = source["expiry_date"];
	        this.tags = source["tags"];
	        this.notes = source["notes"];
	    }
	}
	
	export class ProductSetCreateRequest {
	    name: string;
	    tags: string[];
	    notes: string;
	
	    static createFrom(source: any = {}) {
	        return new ProductSetCreateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.tags = source["tags"];
	        this.notes = source["notes"];
	    }
	}
	
	
	export class ProductSetUpdateRequest {
	    name: string;
	    tags: string[];
	    notes: string;
	
	    static createFrom(source: any = {}) {
	        return new ProductSetUpdateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.tags = source["tags"];
	        this.notes = source["notes"];
	    }
	}
	
	export class SubfolderCreateRequest {
	    product_set: string;
	    file_type: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new SubfolderCreateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.product_set = source["product_set"];
	        this.file_type = source["file_type"];
	        this.name = source["name"];
	    }
	}
	

}

export namespace updater {
	
	export class UpdateInfo {
	    version: string;
	    download_url: string;
	    checksum: string;
	    release_notes: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.download_url = source["download_url"];
	        this.checksum = source["checksum"];
	        this.release_notes = source["release_notes"];
	    }
	}

}

